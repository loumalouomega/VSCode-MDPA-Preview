/**
 * The host-side relay for linked previews (no vscode imports, so it is
 * Node-testable with fake members; the vscode glue only supplies the quick
 * pick and the session adapter).
 *
 * Each open preview registers as a `LinkMember`. Members are joined into link
 * groups that share one `LinkSettings`; a webview reports what changed
 * (`linkEvent`) and the hub relays it to the other members of its group when
 * that setting is switched on. The hub never reads a mesh and never touches a
 * history — a link is view state, exactly like the split view it extends.
 *
 * Physical time is matched HERE, not in the webviews: only the hub knows both
 * series' time axes, and a match that fails is disclosed to both previews
 * instead of being papered over with a frame index.
 */

import * as path from "node:path";

import {
  LinkKind,
  LinkSettings,
  DEFAULT_LINK_SETTINGS,
  SavedLink,
  matchTime,
  validateCameraPayload,
  validateClipPayload,
  validateLinkSettings,
  validateSavedLink,
} from "./previewLink";

export interface LinkMember {
  readonly id: string;
  /** Undefined until a file is bound (the empty shell). */
  readonly fsPath: string | undefined;
  readonly fileName: string | undefined;
  /** Physical times of the series on screen; undefined when its steps are plain step numbers or there is no series. */
  times(): readonly number[] | undefined;
  post(message: Record<string, unknown>): void;
}

interface Group {
  members: Set<string>;
  settings: LinkSettings;
}

interface PendingLink {
  requester: string;
  /** Absolute path the requester was linked with. */
  peerPath: string;
  settings: LinkSettings;
}

export type PeerPicker = (requester: LinkMember, candidates: LinkMember[]) => Promise<LinkMember | undefined>;

const norm = (p: string): string => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
const posix = (p: string): string => p.split(path.sep).join("/");

export class PreviewLinkHub {
  private readonly members = new Map<string, LinkMember>();
  private readonly groups = new Map<string, Group>();
  private pending: PendingLink[] = [];
  /** Installed by the vscode glue; without it `linkPick` answers with a note. */
  public pickPeer: PeerPicker | undefined;

  register(member: LinkMember): () => void {
    this.members.set(member.id, member);
    this.resolvePending(member);
    return () => this.unregister(member.id);
  }

  /** Call once a member's file is bound or re-bound, so a waiting restore can find it. */
  rebind(member: LinkMember): void {
    this.resolvePending(member);
    this.postState(member.id);
  }

  private unregister(id: string): void {
    this.leave(id);
    this.members.delete(id);
    this.pending = this.pending.filter((p) => p.requester !== id);
  }

  groupOf(id: string): Group | undefined {
    return this.groups.get(id);
  }

  peersOf(id: string): LinkMember[] {
    const g = this.groups.get(id);
    if (!g) return [];
    return [...g.members].filter((m) => m !== id).map((m) => this.members.get(m)!).filter(Boolean);
  }

  /** Previews with a file bound that `member` could link with (not itself, not already a peer). */
  candidates(member: LinkMember): LinkMember[] {
    const peers = new Set(this.peersOf(member.id).map((p) => p.id));
    return [...this.members.values()].filter((m) => m.id !== member.id && m.fsPath !== undefined && !peers.has(m.id));
  }

  link(a: LinkMember, b: LinkMember, settings?: LinkSettings): void {
    if (a.id === b.id) return;
    const ga = this.groups.get(a.id);
    const gb = this.groups.get(b.id);
    let group: Group;
    if (ga && gb && ga !== gb) {
      for (const id of gb.members) {
        ga.members.add(id);
        this.groups.set(id, ga);
      }
      group = ga;
    } else {
      group = ga ?? gb ?? { members: new Set<string>(), settings: settings ? validateLinkSettings(settings) : { ...DEFAULT_LINK_SETTINGS } };
    }
    const fresh = !group.members.has(b.id) || !group.members.has(a.id);
    for (const m of [a, b]) {
      group.members.add(m.id);
      this.groups.set(m.id, group);
    }
    // The preview that asked for the link is the one whose view the others adopt:
    // two previews that both reported their own view at once would simply swap.
    for (const id of group.members) this.postState(id, undefined, fresh && id === a.id);
  }

  private leave(id: string): void {
    const g = this.groups.get(id);
    if (!g) return;
    g.members.delete(id);
    this.groups.delete(id);
    if (g.members.size <= 1) {
      for (const other of g.members) this.groups.delete(other);
      for (const other of g.members) this.postState(other);
    } else for (const other of g.members) this.postState(other);
    this.postState(id);
  }

  unlink(member: LinkMember): void {
    this.pending = this.pending.filter((p) => p.requester !== member.id);
    this.leave(member.id);
  }

  private resolvePending(member: LinkMember): void {
    if (!member.fsPath) return;
    const mine = norm(member.fsPath);
    const keep: PendingLink[] = [];
    for (const p of this.pending) {
      const requester = this.members.get(p.requester);
      if (!requester) continue;
      if (p.peerPath === mine && requester.id !== member.id) this.link(requester, member, p.settings);
      else keep.push(p);
    }
    this.pending = keep;
    // The newcomer may itself be the one that remembers a peer that is already open.
  }

  /** The state a webview shows: who it is linked with (names + relative paths) and the shared settings. */
  postState(id: string, note?: string, initiator = false): void {
    const m = this.members.get(id);
    if (!m) return;
    const g = this.groups.get(id);
    const peers = this.peersOf(id);
    const here = m.fsPath ? path.dirname(m.fsPath) : undefined;
    m.post({
      type: "linkState",
      linked: peers.length > 0,
      peers: peers.map((p) => ({
        name: p.fileName ?? "preview",
        path: here && p.fsPath ? posix(path.relative(here, p.fsPath)) : (p.fileName ?? ""),
      })),
      settings: g?.settings ?? { ...DEFAULT_LINK_SETTINGS },
      candidates: this.candidates(m).length,
      note,
      initiator,
    });
  }

  private note(m: LinkMember, message: string): void {
    m.post({ type: "linkNote", message });
  }

  /** Handles one `link*` message from a member's webview; false when it is not one. */
  async handle(member: LinkMember, msg: Record<string, unknown>): Promise<boolean> {
    switch (msg.type) {
      case "linkStateRequest":
        this.postState(member.id);
        return true;
      case "linkPick": {
        const candidates = this.candidates(member);
        if (!this.pickPeer) {
          this.note(member, "Linking needs another open preview.");
          return true;
        }
        if (candidates.length === 0) {
          this.note(member, "Open a second mesh or run in another preview first, then link them.");
          return true;
        }
        const peer = await this.pickPeer(member, candidates);
        if (peer) this.link(member, peer);
        return true;
      }
      case "linkUnlink":
        this.unlink(member);
        return true;
      case "linkSettings": {
        const g = this.groups.get(member.id);
        if (!g) return true;
        g.settings = validateLinkSettings(msg.settings);
        for (const id of g.members) this.postState(id);
        return true;
      }
      case "linkRestore": {
        const { link } = validateSavedLink(msg.saved);
        if (link) this.restore(member, link);
        return true;
      }
      case "linkEvent":
        this.relay(member, msg.kind as LinkKind, msg.payload);
        return true;
      default:
        return false;
    }
  }

  /** Re-links a preview with the runs its saved view was compared with, now or when they open. */
  restore(member: LinkMember, saved: SavedLink): void {
    if (!member.fsPath) return;
    const here = path.dirname(member.fsPath);
    for (const rel of saved.peers) {
      const abs = norm(path.resolve(here, rel));
      const peer = [...this.members.values()].find((m) => m.id !== member.id && m.fsPath && norm(m.fsPath) === abs);
      if (peer) this.link(member, peer, saved.settings);
      else this.pending.push({ requester: member.id, peerPath: abs, settings: saved.settings });
    }
  }

  private relay(origin: LinkMember, kind: LinkKind, payload: unknown): void {
    const g = this.groups.get(origin.id);
    if (!g || !g.settings[kind]) return;
    const peers = this.peersOf(origin.id);
    if (kind === "time") {
      this.relayTime(origin, peers, g.settings, payload);
      return;
    }
    let clean: unknown = payload;
    if (kind === "camera") clean = validateCameraPayload(payload);
    else if (kind === "clip") clean = validateClipPayload(payload);
    if (clean === undefined || clean === null) return;
    for (const p of peers) p.post({ type: "linkApply", kind, payload: clean, from: origin.fileName ?? "a linked preview" });
  }

  private relayTime(origin: LinkMember, peers: LinkMember[], s: LinkSettings, payload: unknown): void {
    const t = (payload as { time?: unknown } | undefined)?.time;
    if (typeof t !== "number" || !Number.isFinite(t)) {
      this.note(origin, "This series has no physical times (its steps are step numbers), so time is not linked.");
      return;
    }
    for (const p of peers) {
      const times = p.times();
      const name = p.fileName ?? "the linked preview";
      if (!times || times.length === 0) {
        this.note(origin, `${name} has no physical times, so it stays on its own frame.`);
        continue;
      }
      const m = matchTime(times, t, s.timeMethod, s.timeTolerance);
      if (!m.ok) {
        const msg = `t = ${t} has no frame in ${name}: ${m.reason}. It stays on its own frame.`;
        this.note(origin, msg);
        this.note(p, msg);
        continue;
      }
      p.post({ type: "linkApply", kind: "time", payload: { index: m.index, time: m.time, delta: m.delta }, from: origin.fileName ?? "a linked preview" });
      if (m.delta !== 0) this.note(origin, `${name}: nearest frame is t = ${m.time} (Δ ${m.delta > 0 ? "+" : ""}${m.delta}).`);
    }
  }
}

/** The one hub of the extension host. */
export const previewLinks = new PreviewLinkHub();
