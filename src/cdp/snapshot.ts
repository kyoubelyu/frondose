import type { CdpHandle, RefMap, Snapshot, SnapshotOptions } from "./types.js";

interface AXValue {
  type: string;
  value?: unknown;
}

interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  backendDOMNodeId?: number;
}

/**
 * [P-75 P-WEDGE-1] Optional race wrapper threaded from CdpClient.snapshot() so the
 * getFullAXTree calls (the `inspect` path — the most common real-world hang surface
 * on a heavy LinkedIn page) are bounded by the per-call deadline + turn abort signal.
 * Defaults to identity when called without a wrapper (e.g. direct/test callers), so
 * existing behavior is unchanged when no wrapper is supplied.
 */
type RaceFn = <T>(p: Promise<T>, label: string) => Promise<T>;
const IDENTITY_RACE: RaceFn = (p) => p;

/**
 * Snapshot the current page via the Accessibility domain.
 * Zero DOM mutation; mirrors Playwright's ariaSnapshot() data source.
 * Per scout Q-P2.5 G-4 resolution.
 */
export async function getSnapshot(
  client: CdpHandle,
  _opts?: SnapshotOptions,
  race: RaceFn = IDENTITY_RACE,
): Promise<Snapshot> {
  await race(client.Accessibility.enable(), "Accessibility.enable");
  let nodes: AXNode[];
  try {
    ({ nodes } = (await race(client.Accessibility.getFullAXTree({}), "Accessibility.getFullAXTree")) as {
      nodes: AXNode[];
    });
  } catch {
    // [INSPECT-1] RC-2: getFullAXTree can throw on a transitioning/animating AX tree (e.g. a
    // dropdown re-open). Retry ONCE after a short settle delay before surfacing the failure.
    await new Promise((r) => setTimeout(r, 100));
    ({ nodes } = (await race(client.Accessibility.getFullAXTree({}), "Accessibility.getFullAXTree")) as {
      nodes: AXNode[];
    });
  }

  const refs: RefMap = {};
  const lines: string[] = [];
  let counter = 0;

  for (const node of nodes) {
    if (node.ignored === true) continue;
    if (!node.role || typeof node.role.value !== "string") continue;
    if (typeof node.backendDOMNodeId !== "number") continue;

    counter++;
    const ref = `e${counter}`;
    const role = node.role.value;
    const name = typeof node.name?.value === "string" ? node.name.value : undefined;
    refs[ref] = {
      axNodeId: node.nodeId,
      backendNodeId: node.backendDOMNodeId,
      role,
      name,
    };
    const namePart = name ? ` "${name.replace(/"/g, '\\"')}"` : "";
    lines.push(`- ${role}${namePart} [ref=@${ref}]`);
  }

  return { tree: lines.join("\n"), refs };
}
