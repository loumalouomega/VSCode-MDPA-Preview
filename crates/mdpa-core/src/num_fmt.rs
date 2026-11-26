//! Fast numeric parsing and exact JS-compatible formatting for MDPA.

use std::fmt::Write as _;

/// Fast ASCII `parseInt(s, 10)` returning `Option<i32>` matching JS `parseInt(tok, 10)`
/// followed by `Int32Array` truncation (`ToInt32`) for typical MDPA tokens.
#[inline]
pub fn parse_i32_token(b: &[u8]) -> Option<i32> {
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= b.len() {
        return None;
    }
    let neg = match b[i] {
        b'-' => {
            i += 1;
            true
        }
        b'+' => {
            i += 1;
            false
        }
        _ => false,
    };
    if i >= b.len() || !b[i].is_ascii_digit() {
        return None;
    }
    let mut acc: i64 = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        acc = acc.wrapping_mul(10).wrapping_add((b[i] - b'0') as i64);
        i += 1;
    }
    let signed = if neg { acc.wrapping_neg() } else { acc };
    Some(signed as i32)
}

/// Strict integer check matching `/^-?\d+$/` (used by `propertiesIdFromArgs`).
#[inline]
pub fn parse_strict_i32(s: &str) -> Option<i32> {
    let b = s.as_bytes();
    if b.is_empty() {
        return None;
    }
    let start = if b[0] == b'-' { 1 } else { 0 };
    if start == b.len() || !b[start..].iter().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse::<i64>().ok().map(|v| v as i32)
}

/// Fast JS `Number(s)` for ASCII tokens (returns `f64::NAN` on invalid).
#[inline]
pub fn parse_f64_token(b: &[u8]) -> f64 {
    let s = trim_ascii_bytes(b);
    if s.is_empty() {
        return 0.0;
    }
    match fast_float2::parse::<f64, _>(s) {
        Ok(v) => v,
        Err(_) => {
            // Handle JS `Infinity`, `+Infinity`, `-Infinity`
            if s == b"Infinity" || s == b"+Infinity" {
                f64::INFINITY
            } else if s == b"-Infinity" {
                f64::NEG_INFINITY
            } else {
                f64::NAN
            }
        }
    }
}

#[inline]
pub fn trim_ascii_bytes(mut b: &[u8]) -> &[u8] {
    while let Some(&first) = b.first() {
        if first.is_ascii_whitespace() {
            b = &b[1..];
        } else {
            break;
        }
    }
    while let Some(&last) = b.last() {
        if last.is_ascii_whitespace() {
            b = &b[..b.len() - 1];
        } else {
            break;
        }
    }
    b
}

/// Format an `f64` identically to JS:
/// ```js
/// function num(x) {
///   if (!isFinite(x)) return "0";
///   if (Number.isInteger(x)) return String(x);
///   return String(parseFloat(x.toPrecision(7)));
/// }
/// ```
#[inline]
pub fn push_num(out: &mut Vec<u8>, x: f64) {
    if !x.is_finite() || x == 0.0 {
        out.push(b'0');
        return;
    }
    if x.fract() == 0.0 {
        if x.abs() < 1e21 {
            if x >= -9_007_199_254_740_992.0 && x <= 9_007_199_254_740_992.0 {
                let mut buf = itoa::Buffer::new();
                out.extend_from_slice(buf.format(x as i64).as_bytes());
                return;
            }
            push_js_number(out, x, false);
            return;
        }
        push_js_number(out, x, false);
        return;
    }
    push_js_number(out, x, true);
}

/// Format an `f64` identically to JS `constraintNum(x)`:
/// ```js
/// function constraintNum(x) {
///   if (!Number.isFinite(x)) return "0.0";
///   if (Number.isInteger(x)) return x.toFixed(1);
///   return String(parseFloat(x.toPrecision(7)));
/// }
/// ```
#[inline]
pub fn push_constraint_num(out: &mut Vec<u8>, x: f64) {
    if !x.is_finite() || x == 0.0 {
        out.extend_from_slice(b"0.0");
        return;
    }
    if x.fract() == 0.0 {
        if x.abs() < 1e21 {
            if x >= -9_007_199_254_740_992.0 && x <= 9_007_199_254_740_992.0 {
                let mut buf = itoa::Buffer::new();
                out.extend_from_slice(buf.format(x as i64).as_bytes());
                out.extend_from_slice(b".0");
                return;
            }
            push_js_number(out, x, false);
            out.extend_from_slice(b".0");
            return;
        }
        // JS `(1e21).toFixed(1)` returns `"1e+21"`
        push_js_number(out, x, false);
        return;
    }
    push_js_number(out, x, true);
}

pub fn format_num_string(x: f64) -> String {
    let mut out = Vec::with_capacity(24);
    push_num(&mut out, x);
    // Safety: push_num only writes ASCII bytes.
    unsafe { String::from_utf8_unchecked(out) }
}

pub fn format_constraint_num_string(x: f64) -> String {
    let mut out = Vec::with_capacity(24);
    push_constraint_num(&mut out, x);
    unsafe { String::from_utf8_unchecked(out) }
}

/// Decide exact round-half-away-from-zero at 7 significant digits for a potential tie
/// by inspecting the true binary `f64` value via Rust's exact Dragon4 formatter.
#[cold]
fn exact_round_up_at_7(abs: f64) -> bool {
    let mut s = StackBuf::<64>::new();
    let _ = write!(&mut s, "{:.40e}", abs);
    let b = s.as_bytes();
    // Format is `d.dddd...e±exp`; the 8th significant digit is at b[8].
    // With 41 digits of precision, a true binary value strictly below the midpoint
    // (like -12.206785 = -12.2067849999999999966...) always has b[8] == '4',
    // while an exact dyadic tie (like 101325.25) has b[8] == '5'.
    if b.len() <= 8 {
        return false;
    }
    b[8] >= b'5'
}

/// Format a finite non-zero `f64` identically to ECMA-262 `Number::toString`,
/// optionally rounding to 7 significant digits (half-away-from-zero, matching
/// `String(parseFloat(x.toPrecision(7)))`).
#[inline]
fn push_js_number(out: &mut Vec<u8>, x: f64, round_prec7: bool) {
    if x == 0.0 {
        out.push(b'0');
        return;
    }
    let neg = x.is_sign_negative();
    let abs = x.abs();
    if neg {
        out.push(b'-');
    }

    let mut rbuf = ryu::Buffer::new();
    let s = rbuf.format_finite(abs);
    let bytes = s.as_bytes();

    let mut digits = [0u8; 24];
    let mut n_digits = 0usize;
    let mut dot_pos: Option<usize> = None;
    let mut e_pos: Option<usize> = None;

    for (idx, &c) in bytes.iter().enumerate() {
        if c == b'.' {
            dot_pos = Some(idx);
        } else if c == b'e' || c == b'E' {
            e_pos = Some(idx);
            break;
        }
    }

    let mantissa_end = e_pos.unwrap_or(bytes.len());
    let mut exp10: i32 = if let Some(ep) = e_pos {
        parse_exp(&bytes[ep + 1..])
    } else {
        0
    };

    let mut first_nonzero: Option<usize> = None;
    let mut digit_idx = 0usize;
    let mut digits_before_dot = 0usize;
    for (idx, &c) in bytes[..mantissa_end].iter().enumerate() {
        if c == b'.' {
            continue;
        }
        if dot_pos.map_or(true, |dp| idx < dp) {
            digits_before_dot += 1;
        }
        if first_nonzero.is_none() {
            if c != b'0' {
                first_nonzero = Some(digit_idx);
                digits[n_digits] = c;
                n_digits += 1;
            }
        } else {
            digits[n_digits] = c;
            n_digits += 1;
        }
        digit_idx += 1;
    }

    if let Some(fnz) = first_nonzero {
        exp10 += (digits_before_dot as i32) - 1 - (fnz as i32);
    } else {
        out.push(b'0');
        return;
    }

    // Round to 7 significant digits (exact ECMA-262 half-away-from-zero)
    if round_prec7 && n_digits > 7 {
        let round_up = if digits[7] > b'5' {
            true
        } else if digits[7] < b'5' {
            false
        } else if digits[8..n_digits].iter().any(|&d| d != b'0') {
            true
        } else {
            exact_round_up_at_7(abs)
        };
        n_digits = 7;
        if round_up {
            let mut carry = true;
            for i in (0..7).rev() {
                if digits[i] < b'9' {
                    digits[i] += 1;
                    carry = false;
                    break;
                } else {
                    digits[i] = b'0';
                }
            }
            if carry {
                digits[0] = b'1';
                n_digits = 1;
                exp10 += 1;
            }
        }
    }

    // Trim trailing zeros
    while n_digits > 1 && digits[n_digits - 1] == b'0' {
        n_digits -= 1;
    }

    // ECMA-262 Number::toString rules:
    let n = exp10 + 1;
    let k = n_digits as i32;

    if k <= n && n <= 21 {
        out.extend_from_slice(&digits[..n_digits]);
        for _ in 0..(n - k) {
            out.push(b'0');
        }
    } else if 0 < n && n <= 21 {
        let nu = n as usize;
        out.extend_from_slice(&digits[..nu]);
        out.push(b'.');
        out.extend_from_slice(&digits[nu..n_digits]);
    } else if -6 < n && n <= 0 {
        out.extend_from_slice(b"0.");
        for _ in 0..(-n) {
            out.push(b'0');
        }
        out.extend_from_slice(&digits[..n_digits]);
    } else {
        out.push(digits[0]);
        if n_digits > 1 {
            out.push(b'.');
            out.extend_from_slice(&digits[1..n_digits]);
        }
        out.push(b'e');
        if exp10 >= 0 {
            out.push(b'+');
            let mut ibuf = itoa::Buffer::new();
            out.extend_from_slice(ibuf.format(exp10).as_bytes());
        } else {
            out.push(b'-');
            let mut ibuf = itoa::Buffer::new();
            out.extend_from_slice(ibuf.format(-exp10).as_bytes());
        }
    }
}

#[inline]
fn parse_exp(b: &[u8]) -> i32 {
    if b.is_empty() {
        return 0;
    }
    let (neg, rest) = match b[0] {
        b'-' => (true, &b[1..]),
        b'+' => (false, &b[1..]),
        _ => (false, b),
    };
    let mut v: i32 = 0;
    for &c in rest {
        if c.is_ascii_digit() {
            v = v * 10 + (c - b'0') as i32;
        }
    }
    if neg { -v } else { v }
}

/// Tiny stack-allocated buffer implementing `std::fmt::Write` to avoid heap allocations.
struct StackBuf<const N: usize> {
    buf: [u8; N],
    len: usize,
}

impl<const N: usize> StackBuf<N> {
    #[inline]
    fn new() -> Self {
        Self { buf: [0; N], len: 0 }
    }
    #[inline]
    fn as_bytes(&self) -> &[u8] {
        &self.buf[..self.len]
    }
}

impl<const N: usize> std::fmt::Write for StackBuf<N> {
    #[inline]
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        let bytes = s.as_bytes();
        let avail = N - self.len;
        let take = bytes.len().min(avail);
        self.buf[self.len..self.len + take].copy_from_slice(&bytes[..take]);
        self.len += take;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_num_formatting() {
        assert_eq!(format_num_string(0.0), "0");
        assert_eq!(format_num_string(-0.0), "0");
        assert_eq!(format_num_string(1.0), "1");
        assert_eq!(format_num_string(-42.0), "-42");
        assert_eq!(format_num_string(0.1_f32 as f64), "0.1");
        assert_eq!(format_num_string(0.25), "0.25");
        assert_eq!(format_num_string(3.4e-5), "0.000034");
        assert_eq!(format_num_string(1e-7), "1e-7");
        assert_eq!(format_num_string(1e21), "1e+21");
        assert_eq!(format_num_string(f64::NAN), "0");
        assert_eq!(format_constraint_num_string(0.0), "0.0");
        assert_eq!(format_constraint_num_string(1.0), "1.0");
        assert_eq!(format_constraint_num_string(0.25), "0.25");
    }
}
