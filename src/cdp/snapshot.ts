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
 * Snapshot the current page via the Accessibility domain.
 * Zero DOM mutation; mirrors Playwright's ariaSnapshot() data source.
 * Per scout Q-P2.5 G-4 resolution.
 */
export async function getSnapshot(client: CdpHandle, _opts?: SnapshotOptions): Promise<Snapshot> {
  await client.Accessibility.enable();
  const { nodes } = (await client.Accessibility.getFullAXTree({})) as { nodes: AXNode[] };

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
