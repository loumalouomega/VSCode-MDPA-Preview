# Optimization summary fixtures

Hand-written to the format `optimization_problem_ascii_output_process` (OptimizationApplication, master) writes: `#`-comment header lines, an "Initial values" block, `# Headers:` followed by a `#  STEP, …` line, one row per step and `# End of file` once the process finalizes. They are not captured from a solver run.

- `steepest_descent.csv`: an unconstrained steepest-descent run that finalized (ten steps of a strain-energy objective).
- `gradient_projection_cut.csv`: a constrained gradient-projection run that was killed mid-write (no end marker, last row cut short).
