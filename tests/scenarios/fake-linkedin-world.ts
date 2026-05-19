import { CdpClient } from "../../src/cdp/client.js";
import type { CdpHandle } from "../../src/cdp/types.js";
import type { CurrentSurfaceContext, LinkedInSurface, LinkedinSession } from "../../src/linkedin/types.js";

// ── AX node shape (matching Accessibility.getFullAXTree return) ──

interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { type: string; value?: unknown };
  name?: { type: string; value?: unknown };
  backendDOMNodeId?: number;
}

// ── Page preset ──

interface WorldPage {
  key: string;
  url: string;
  surface: LinkedInSurface;
  axNodes: AXNode[];
  /** BackendNodeId → target page key transitions on click */
  transitions?: Map<number, string>;
}

// ── CDP call record ──

export interface CdpCallRecord {
  method: string;
  args?: Record<string, unknown>;
}

// ── Feed AX nodes (29 nodes — §6.7) ──

const FEED_AX_NODES: AXNode[] = [
  // ── Composer ──
  {
    nodeId: "ax1",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Start a post" },
    backendDOMNodeId: 101,
  },
  {
    nodeId: "ax2",
    role: { type: "role", value: "textbox" },
    name: { type: "string", value: "Write something..." },
    backendDOMNodeId: 102,
  },
  // ── Post 1: Alex Chen ──
  {
    nodeId: "ax3",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "Alex Chen" },
    backendDOMNodeId: 103,
  },
  {
    nodeId: "ax4",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "VP Sales @ Acme Corp" },
    backendDOMNodeId: 104,
  },
  {
    nodeId: "ax5",
    role: { type: "role", value: "staticText" },
    name: {
      type: "string",
      value:
        "Just closed our largest enterprise deal this quarter. Key insight: buyers care more about outcome certainty than price. #Sales #B2B",
    },
    backendDOMNodeId: 105,
  },
  {
    nodeId: "ax6",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Like" },
    backendDOMNodeId: 106,
  },
  {
    nodeId: "ax7",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Comment" },
    backendDOMNodeId: 107,
  },
  {
    nodeId: "ax8",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Repost" },
    backendDOMNodeId: 108,
  },
  // ── Post 2: Sarah Kim ──
  {
    nodeId: "ax9",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "Sarah Kim" },
    backendDOMNodeId: 109,
  },
  {
    nodeId: "ax10",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "CTO @ DataFlow Inc" },
    backendDOMNodeId: 110,
  },
  {
    nodeId: "ax11",
    role: { type: "role", value: "staticText" },
    name: {
      type: "string",
      value:
        "We migrated our entire data pipeline to Kafka. 3 months of work, but latency dropped 80%. Happy to share learnings.",
    },
    backendDOMNodeId: 111,
  },
  {
    nodeId: "ax12",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Like" },
    backendDOMNodeId: 112,
  },
  {
    nodeId: "ax13",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Comment" },
    backendDOMNodeId: 113,
  },
  // ── Post 3: Mark Rivera (ICP-relevant: VP Sales) ──
  {
    nodeId: "ax14",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "Mark Rivera" },
    backendDOMNodeId: 114,
  },
  {
    nodeId: "ax15",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "VP Sales @ Nexus Global" },
    backendDOMNodeId: 115,
  },
  {
    nodeId: "ax16",
    role: { type: "role", value: "staticText" },
    name: {
      type: "string",
      value:
        "Sales hiring in 2026: we're looking for reps who can do value-based selling, not just product demos. The bar is rising.",
    },
    backendDOMNodeId: 116,
  },
  {
    nodeId: "ax17",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Like" },
    backendDOMNodeId: 117,
  },
  {
    nodeId: "ax18",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Comment" },
    backendDOMNodeId: 118,
  },
  {
    nodeId: "ax19",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Repost" },
    backendDOMNodeId: 119,
  },
  // ── Post 4: Emily Zhang (non-ICP, Engineering) ──
  {
    nodeId: "ax20",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "Emily Zhang" },
    backendDOMNodeId: 120,
  },
  {
    nodeId: "ax21",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Staff Engineer @ BuildCo" },
    backendDOMNodeId: 121,
  },
  {
    nodeId: "ax22",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Just published a deep dive on event sourcing patterns. Link in comments." },
    backendDOMNodeId: 122,
  },
  {
    nodeId: "ax23",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Like" },
    backendDOMNodeId: 123,
  },
  // ── Post 5: James Okafor (ICP-relevant: CRO) ──
  {
    nodeId: "ax24",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "James Okafor" },
    backendDOMNodeId: 124,
  },
  {
    nodeId: "ax25",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "CRO @ ScaleUp SaaS" },
    backendDOMNodeId: 125,
  },
  {
    nodeId: "ax26",
    role: { type: "role", value: "staticText" },
    name: {
      type: "string",
      value:
        "The #1 mistake I see in sales orgs: not qualifying early enough. Every hour spent on the wrong deal is an hour stolen from the right one.",
    },
    backendDOMNodeId: 126,
  },
  {
    nodeId: "ax27",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Like" },
    backendDOMNodeId: 127,
  },
  {
    nodeId: "ax28",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Comment" },
    backendDOMNodeId: 128,
  },
  {
    nodeId: "ax29",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Share" },
    backendDOMNodeId: 129,
  },
];

// ── Search AX nodes (31 nodes — §6.8) ──

const SEARCH_AX_NODES: AXNode[] = [
  // ── Search input ──
  {
    nodeId: "ax1",
    role: { type: "role", value: "searchbox" },
    name: { type: "string", value: "Search" },
    backendDOMNodeId: 201,
  },
  // ── Result 1: Alex Chen (VP Sales, full ICP match) ──
  {
    nodeId: "ax2",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "Alex Chen — VP Sales, Acme Corp" },
    backendDOMNodeId: 202,
  },
  {
    nodeId: "ax3",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "VP Sales at Acme Corp · San Francisco, CA" },
    backendDOMNodeId: 203,
  },
  {
    nodeId: "ax4",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 204,
  },
  // ── Result 2: Maria Santos (CRO, full ICP match) ──
  {
    nodeId: "ax5",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "Maria Santos — CRO, DataSync Technologies" },
    backendDOMNodeId: 205,
  },
  {
    nodeId: "ax6",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "CRO at DataSync Technologies · Austin, TX" },
    backendDOMNodeId: 206,
  },
  {
    nodeId: "ax7",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 207,
  },
  // ── Result 3: David Park (VP Sales, partial match) ──
  {
    nodeId: "ax8",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "David Park — VP Sales, HealthFirst" },
    backendDOMNodeId: 208,
  },
  {
    nodeId: "ax9",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "VP Sales at HealthFirst · Chicago, IL" },
    backendDOMNodeId: 209,
  },
  {
    nodeId: "ax10",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 210,
  },
  // ── Result 4: Linda Wu (Head of Sales, partial match) ──
  {
    nodeId: "ax11",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "Linda Wu — Head of Sales, CloudKit" },
    backendDOMNodeId: 211,
  },
  {
    nodeId: "ax12",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Head of Sales at CloudKit · Seattle, WA" },
    backendDOMNodeId: 212,
  },
  {
    nodeId: "ax13",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 213,
  },
  // ── Result 5: Tom Bradley (CRO, partial match — different region) ──
  {
    nodeId: "ax14",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "Tom Bradley — CRO, EuroTech GmbH" },
    backendDOMNodeId: 214,
  },
  {
    nodeId: "ax15",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "CRO at EuroTech GmbH · Berlin, Germany" },
    backendDOMNodeId: 215,
  },
  {
    nodeId: "ax16",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 216,
  },
  // ── Result 6: Rachel Torres (VP Sales, full ICP match) ──
  {
    nodeId: "ax17",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "Rachel Torres — VP Sales, FinStack" },
    backendDOMNodeId: 217,
  },
  {
    nodeId: "ax18",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "VP Sales at FinStack · New York, NY" },
    backendDOMNodeId: 218,
  },
  {
    nodeId: "ax19",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 219,
  },
  // ── Result 7: Kevin Huang (Engineering, non-ICP) ──
  {
    nodeId: "ax20",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "Kevin Huang — VP Engineering, BuildRight" },
    backendDOMNodeId: 220,
  },
  {
    nodeId: "ax21",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "VP Engineering at BuildRight · Denver, CO" },
    backendDOMNodeId: 221,
  },
  {
    nodeId: "ax22",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 222,
  },
  // ── Result 8: Nina Patel (VP Sales, full ICP match) ──
  {
    nodeId: "ax23",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "Nina Patel — VP Sales, Quantum Analytics" },
    backendDOMNodeId: 223,
  },
  {
    nodeId: "ax24",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "VP Sales at Quantum Analytics · Boston, MA" },
    backendDOMNodeId: 224,
  },
  {
    nodeId: "ax25",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 225,
  },
  // ── Result 9: Steve Miller (Sales Ops, wrong role) ──
  {
    nodeId: "ax26",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "Steve Miller — Sales Ops Manager, MegaCorp" },
    backendDOMNodeId: 226,
  },
  {
    nodeId: "ax27",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Sales Ops Manager at MegaCorp · Dallas, TX" },
    backendDOMNodeId: 227,
  },
  {
    nodeId: "ax28",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 228,
  },
  // ── Result 10: Omar Hassan (CRO, full ICP match) ──
  {
    nodeId: "ax29",
    role: { type: "role", value: "link" },
    name: { type: "string", value: "Omar Hassan — CRO, SwiftPay" },
    backendDOMNodeId: 229,
  },
  {
    nodeId: "ax30",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "CRO at SwiftPay · Los Angeles, CA" },
    backendDOMNodeId: 230,
  },
  {
    nodeId: "ax31",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 231,
  },
];

// ── Profile: Alex Chen (15 nodes — §6.9) ──

const PROFILE_ALEX_AX_NODES: AXNode[] = [
  // ── Hero section ──
  {
    nodeId: "ax1",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Alex Chen" },
    backendDOMNodeId: 301,
  },
  {
    nodeId: "ax2",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "VP Sales at Acme Corp" },
    backendDOMNodeId: 302,
  },
  {
    nodeId: "ax3",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "San Francisco Bay Area" },
    backendDOMNodeId: 303,
  },
  // ── Action buttons ──
  {
    nodeId: "ax4",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 304,
  },
  {
    nodeId: "ax5",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Message" },
    backendDOMNodeId: 305,
  },
  {
    nodeId: "ax6",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "More" },
    backendDOMNodeId: 306,
  },
  // ── About section ──
  {
    nodeId: "ax7",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "About" },
    backendDOMNodeId: 307,
  },
  {
    nodeId: "ax8",
    role: { type: "role", value: "staticText" },
    name: {
      type: "string",
      value:
        "Experienced VP Sales with 12+ years in B2B SaaS. Passionate about building high-performance sales teams and value-based selling methodologies.",
    },
    backendDOMNodeId: 308,
  },
  // ── Experience section ──
  {
    nodeId: "ax9",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Experience" },
    backendDOMNodeId: 309,
  },
  {
    nodeId: "ax10",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "VP Sales, Acme Corp · 2020 - Present" },
    backendDOMNodeId: 310,
  },
  {
    nodeId: "ax11",
    role: { type: "role", value: "staticText" },
    name: {
      type: "string",
      value: "Led 40-person sales org from $20M to $65M ARR in 3 years. Built enterprise sales process from scratch.",
    },
    backendDOMNodeId: 311,
  },
  {
    nodeId: "ax12",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Director of Sales, StartupHub · 2016 - 2020" },
    backendDOMNodeId: 312,
  },
  {
    nodeId: "ax13",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Managed SMB sales team of 15. Grew segment 3x year-over-year." },
    backendDOMNodeId: 313,
  },
  // ── Education ──
  {
    nodeId: "ax14",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Education" },
    backendDOMNodeId: 314,
  },
  {
    nodeId: "ax15",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Stanford University, MBA" },
    backendDOMNodeId: 315,
  },
];

// ── Maria Santos — CRO at DataSync Technologies (12 nodes — §6.10) ──
const PROFILE_MARIA_AX_NODES: AXNode[] = [
  {
    nodeId: "ax1",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Maria Santos" },
    backendDOMNodeId: 401,
  },
  {
    nodeId: "ax2",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "CRO at DataSync Technologies" },
    backendDOMNodeId: 402,
  },
  {
    nodeId: "ax3",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Austin, TX" },
    backendDOMNodeId: 403,
  },
  {
    nodeId: "ax4",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 404,
  },
  {
    nodeId: "ax5",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Message" },
    backendDOMNodeId: 405,
  },
  {
    nodeId: "ax6",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "More" },
    backendDOMNodeId: 406,
  },
  {
    nodeId: "ax7",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "About" },
    backendDOMNodeId: 407,
  },
  {
    nodeId: "ax8",
    role: { type: "role", value: "staticText" },
    name: {
      type: "string",
      value:
        "CRO with 15+ years leading revenue organizations at high-growth B2B tech companies. Scaled DataSync from $5M to $50M ARR.",
    },
    backendDOMNodeId: 408,
  },
  {
    nodeId: "ax9",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Experience" },
    backendDOMNodeId: 409,
  },
  {
    nodeId: "ax10",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "CRO, DataSync Technologies · 2019 - Present" },
    backendDOMNodeId: 410,
  },
  {
    nodeId: "ax11",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Head of Sales, CloudBase · 2015 - 2019" },
    backendDOMNodeId: 411,
  },
  {
    nodeId: "ax12",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Education" },
    backendDOMNodeId: 412,
  },
];

// ── Mark Rivera — VP Sales at Nexus Global (12 nodes — §6.10) ──
const PROFILE_MARK_AX_NODES: AXNode[] = [
  {
    nodeId: "ax1",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Mark Rivera" },
    backendDOMNodeId: 501,
  },
  {
    nodeId: "ax2",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "VP Sales at Nexus Global" },
    backendDOMNodeId: 502,
  },
  {
    nodeId: "ax3",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Greater New York Area" },
    backendDOMNodeId: 503,
  },
  {
    nodeId: "ax4",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 504,
  },
  {
    nodeId: "ax5",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Message" },
    backendDOMNodeId: 505,
  },
  {
    nodeId: "ax6",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "More" },
    backendDOMNodeId: 506,
  },
  {
    nodeId: "ax7",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "About" },
    backendDOMNodeId: 507,
  },
  {
    nodeId: "ax8",
    role: { type: "role", value: "staticText" },
    name: {
      type: "string",
      value:
        "VP Sales focused on building consultative sales teams. 10+ years in enterprise software. Passionate about value-based selling and sales methodology.",
    },
    backendDOMNodeId: 508,
  },
  {
    nodeId: "ax9",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Experience" },
    backendDOMNodeId: 509,
  },
  {
    nodeId: "ax10",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "VP Sales, Nexus Global · 2018 - Present" },
    backendDOMNodeId: 510,
  },
  {
    nodeId: "ax11",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Director of Enterprise Sales, TechVantage · 2014 - 2018" },
    backendDOMNodeId: 511,
  },
  {
    nodeId: "ax12",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Education" },
    backendDOMNodeId: 512,
  },
];

// ── James Okafor — CRO at ScaleUp SaaS (12 nodes — §6.10) ──
const PROFILE_JAMES_AX_NODES: AXNode[] = [
  {
    nodeId: "ax1",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "James Okafor" },
    backendDOMNodeId: 601,
  },
  {
    nodeId: "ax2",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "CRO at ScaleUp SaaS" },
    backendDOMNodeId: 602,
  },
  {
    nodeId: "ax3",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "San Francisco, CA" },
    backendDOMNodeId: 603,
  },
  {
    nodeId: "ax4",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 604,
  },
  {
    nodeId: "ax5",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Message" },
    backendDOMNodeId: 605,
  },
  {
    nodeId: "ax6",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "More" },
    backendDOMNodeId: 606,
  },
  {
    nodeId: "ax7",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "About" },
    backendDOMNodeId: 607,
  },
  {
    nodeId: "ax8",
    role: { type: "role", value: "staticText" },
    name: {
      type: "string",
      value:
        "CRO who believes sales qualification is the most under-invested function in B2B. Built and scaled 3 revenue orgs from seed to Series C.",
    },
    backendDOMNodeId: 608,
  },
  {
    nodeId: "ax9",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Experience" },
    backendDOMNodeId: 609,
  },
  {
    nodeId: "ax10",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "CRO, ScaleUp SaaS · 2020 - Present" },
    backendDOMNodeId: 610,
  },
  {
    nodeId: "ax11",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "VP Revenue, GrowthStack · 2016 - 2020" },
    backendDOMNodeId: 611,
  },
  {
    nodeId: "ax12",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Education" },
    backendDOMNodeId: 612,
  },
];

// ── Stub: Sarah Kim — CTO @ DataFlow Inc (non-ICP feed lead, 4 nodes) ──
const PROFILE_SARAH_AX_NODES: AXNode[] = [
  {
    nodeId: "ax1",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Sarah Kim" },
    backendDOMNodeId: 701,
  },
  {
    nodeId: "ax2",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "CTO at DataFlow Inc" },
    backendDOMNodeId: 702,
  },
  {
    nodeId: "ax3",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "San Francisco, CA" },
    backendDOMNodeId: 703,
  },
  {
    nodeId: "ax4",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 704,
  },
];

// ── Stub: Emily Zhang — Staff Engineer @ BuildCo (non-ICP feed lead, 4 nodes) ──
const PROFILE_EMILY_AX_NODES: AXNode[] = [
  {
    nodeId: "ax1",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Emily Zhang" },
    backendDOMNodeId: 801,
  },
  {
    nodeId: "ax2",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Staff Engineer at BuildCo" },
    backendDOMNodeId: 802,
  },
  {
    nodeId: "ax3",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Seattle, WA" },
    backendDOMNodeId: 803,
  },
  {
    nodeId: "ax4",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 804,
  },
];

// ── Stub: Kevin Huang — VP Engineering @ BuildRight (non-ICP search result, 4 nodes) ──
const PROFILE_KEVIN_AX_NODES: AXNode[] = [
  {
    nodeId: "ax1",
    role: { type: "role", value: "heading" },
    name: { type: "string", value: "Kevin Huang" },
    backendDOMNodeId: 901,
  },
  {
    nodeId: "ax2",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "VP Engineering at BuildRight" },
    backendDOMNodeId: 902,
  },
  {
    nodeId: "ax3",
    role: { type: "role", value: "staticText" },
    name: { type: "string", value: "Denver, CO" },
    backendDOMNodeId: 903,
  },
  {
    nodeId: "ax4",
    role: { type: "role", value: "button" },
    name: { type: "string", value: "Connect" },
    backendDOMNodeId: 904,
  },
];

// ── URL → page key matching ──

function matchUrlToPage(url: string): string | undefined {
  if (url.includes("/feed")) return "feed";
  if (url.includes("/search/results")) return "search";
  if (url.includes("/in/alex-chen")) return "profile-alex";
  if (url.includes("/in/maria-santos")) return "profile-maria";
  if (url.includes("/in/mark-rivera")) return "profile-mark";
  if (url.includes("/in/james-okafor")) return "profile-james";
  if (url.includes("/in/sarah-kim")) return "profile-sarah";
  if (url.includes("/in/emily-zhang")) return "profile-emily";
  if (url.includes("/in/kevin-huang")) return "profile-kevin";
  return undefined;
}

// ── FakeLinkedInWorld ──

export class FakeLinkedInWorld {
  private pages = new Map<string, WorldPage>();
  private _currentPageKey = "feed";
  private _lastQueriedBackendNodeId: number | undefined;
  private _callLog: CdpCallRecord[] = [];

  constructor() {
    // Register all 9 page presets
    this.registerPage({
      key: "feed",
      url: "https://www.linkedin.com/feed/",
      surface: "feed",
      axNodes: FEED_AX_NODES,
      transitions: new Map([
        [103, "profile-alex"], // Alex Chen link
        [109, "profile-sarah"], // Sarah Kim link (CMR-1 fix)
        [114, "profile-mark"], // Mark Rivera link
        [120, "profile-emily"], // Emily Zhang link (CMR-1 fix)
        [124, "profile-james"], // James Okafor link
      ]),
    });
    this.registerPage({
      key: "search",
      url: "https://www.linkedin.com/search/results/all/?keywords=VP%20Sales%20B2B%20SaaS",
      surface: "search",
      axNodes: SEARCH_AX_NODES,
      transitions: new Map([
        [202, "profile-alex"], // Alex Chen result
        [205, "profile-maria"], // Maria Santos result
        [208, "profile-alex"], // David Park → Alex (reuse for simplicity)
        [211, "profile-alex"], // Linda Wu → Alex
        [214, "profile-maria"], // Tom Bradley → Maria (best effort)
        [217, "profile-alex"], // Rachel Torres → Alex
        [220, "profile-kevin"], // Kevin Huang → dedicated stub (non-ICP profile for correct ICP reasoning)
        [223, "profile-alex"], // Nina Patel → Alex
        [226, "profile-alex"], // Steve Miller → Alex
        [229, "profile-maria"], // Omar Hassan → Maria
      ]),
    });
    this.registerPage({
      key: "profile-alex",
      url: "https://www.linkedin.com/in/alex-chen/",
      surface: "profile",
      axNodes: PROFILE_ALEX_AX_NODES,
    });
    this.registerPage({
      key: "profile-maria",
      url: "https://www.linkedin.com/in/maria-santos/",
      surface: "profile",
      axNodes: PROFILE_MARIA_AX_NODES,
    });
    this.registerPage({
      key: "profile-mark",
      url: "https://www.linkedin.com/in/mark-rivera/",
      surface: "profile",
      axNodes: PROFILE_MARK_AX_NODES,
    });
    this.registerPage({
      key: "profile-james",
      url: "https://www.linkedin.com/in/james-okafor/",
      surface: "profile",
      axNodes: PROFILE_JAMES_AX_NODES,
    });
    // CMR-1: stub profiles for non-ICP feed leads (prevents silent click no-ops)
    this.registerPage({
      key: "profile-sarah",
      url: "https://www.linkedin.com/in/sarah-kim/",
      surface: "profile",
      axNodes: PROFILE_SARAH_AX_NODES,
    });
    this.registerPage({
      key: "profile-emily",
      url: "https://www.linkedin.com/in/emily-zhang/",
      surface: "profile",
      axNodes: PROFILE_EMILY_AX_NODES,
    });
    // C-2 awareness: Kevin Huang stub ensures agent sees non-ICP profile when clicking his result
    this.registerPage({
      key: "profile-kevin",
      url: "https://www.linkedin.com/in/kevin-huang/",
      surface: "profile",
      axNodes: PROFILE_KEVIN_AX_NODES,
    });
  }

  registerPage(page: WorldPage): void {
    this.pages.set(page.key, page);
  }

  get currentPageKey(): string {
    return this._currentPageKey;
  }

  get currentPage(): WorldPage {
    return this.pages.get(this._currentPageKey) ?? this.pages.get("feed")!;
  }

  get callLog(): readonly CdpCallRecord[] {
    return this._callLog;
  }

  navigateTo(url: string): void {
    const key = matchUrlToPage(url);
    if (key && this.pages.has(key)) {
      this._currentPageKey = key;
    }
  }

  /** Build a fake CdpHandle that routes all CDP calls through world state. */
  private makeCdpHandle(): CdpHandle {
    return {
      Accessibility: {
        enable: async () => {},
        getFullAXTree: async () => ({ nodes: this.currentPage.axNodes }),
      },
      Page: {
        enable: async () => {},
        navigate: async (args: { url: string }) => {
          this._callLog.push({ method: "Page.navigate", args });
          this.navigateTo(args.url);
          return {};
        },
        // Event subscriptions: chrome-remote-interface event methods return a no-op
        // unsubscribe function. In the fake world, page transitions are synchronous,
        // so we fire callbacks immediately (via setTimeout(0) so the Promise setup
        // in waitForLoad completes first).
        loadEventFired: (cb: (p: { timestamp: number }) => void) => {
          setTimeout(() => cb({ timestamp: Date.now() }), 0);
          return () => {};
        },
        frameNavigated: (cb: (p: { frame: { url: string } }) => void) => {
          setTimeout(() => cb({ frame: { url: this.currentPage.url } }), 0);
          return () => {};
        },
        lifecycleEvent: (cb: (p: { name: string }) => void) => {
          setTimeout(() => cb({ name: "networkIdle" }), 0);
          return () => {};
        },
        setLifecycleEventsEnabled: async () => {},
        getLayoutMetrics: async () => ({
          visualViewport: { pageX: 0, pageY: 0, clientWidth: 1440, clientHeight: 900 },
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1440, clientHeight: 900 },
          cssLayoutViewport: { clientWidth: 1440, clientHeight: 900 },
        }),
        reload: async () => {},
      },
      Runtime: {
        enable: async () => {},
        evaluate: async (args: { expression: string }) => {
          this._callLog.push({ method: "Runtime.evaluate", args });
          if (args.expression.includes("window.location.href")) {
            return { result: { value: this.currentPage.url } };
          }
          return { result: { value: null } };
        },
      },
      DOM: {
        getDocument: async () => ({ root: { nodeId: 1 } }),
        querySelectorAll: async (_args: { nodeId: number; selector: string }) => ({ nodeIds: [42] }),
        getBoxModel: async (args: { backendNodeId?: number; nodeId?: number }) => {
          this._lastQueriedBackendNodeId = args.backendNodeId ?? args.nodeId;
          this._callLog.push({ method: "DOM.getBoxModel", args });
          return { model: { border: [100, 100, 200, 120, 200, 100, 100, 120] } };
        },
        describeNode: async () => ({ node: { nodeName: "INPUT", attributes: [] } }),
        setFileInputFiles: async () => {},
      },
      Input: {
        dispatchMouseEvent: async (args: { type: string; x?: number; y?: number; button?: string }) => {
          this._callLog.push({ method: "Input.dispatchMouseEvent", args });
          // On mouseReleased, check for page transition
          if (args.type === "mouseReleased" && this._lastQueriedBackendNodeId !== undefined) {
            const transitions = this.currentPage.transitions;
            if (transitions) {
              const target = transitions.get(this._lastQueriedBackendNodeId);
              if (target && this.pages.has(target)) {
                this._currentPageKey = target;
              }
            }
            this._lastQueriedBackendNodeId = undefined;
          }
        },
        dispatchKeyEvent: async (args: { type: string; key?: string }) => {
          this._callLog.push({ method: "Input.dispatchKeyEvent", args });
        },
        insertText: async (args: { text: string }) => {
          this._callLog.push({ method: "Input.insertText", args });
        },
        synthesizeScrollGesture: async (args: { x: number; y: number; yDistance: number }) => {
          this._callLog.push({ method: "Input.synthesizeScrollGesture", args });
        },
      },
      Browser: {
        close: async () => {},
      },
    };
  }

  /** Build a LinkedinSession-compatible object backed by this world. */
  makeSession(): LinkedinSession {
    const fakeHandle = this.makeCdpHandle();
    const client = CdpClient.fromHandle(fakeHandle);
    let lastCtx: CurrentSurfaceContext | undefined;

    return {
      inputMode: "cdp" as const,
      getOrInitClient: () => Promise.resolve(client),
      getClient: () => client,
      setLastContext: (ctx: CurrentSurfaceContext) => {
        lastCtx = ctx;
      },
      getLastContext: () => lastCtx,
    };
  }
}
