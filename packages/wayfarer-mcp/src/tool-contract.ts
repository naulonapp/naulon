/**
 * The tool definition contract: what every tool this server lists must tell a model.
 *
 * A model picks a tool from `tools/list` alone. It reads the name, the description, the schemas and
 * the annotations, and nothing else. So the contract is checked on that wire shape, never on the
 * source that produced it: a host that mounts a subset of the tools, or adds its own beside them,
 * runs the same check over what its callers will actually be sent.
 *
 * A description is written in this order, each part one or two sentences:
 *
 *   1. What the tool does and what it returns.
 *   2. When to call it, and which sibling to call for the neighbouring case.
 *   3. What the annotations cannot say: limits, cost, the empty result, a refusal.
 *   4. What an argument means beyond its schema: where its value comes from, how two interact.
 *
 * How to read a result belongs on the output schema's fields, where the result is. A description
 * that explains the result is long, and it is read before every call that will never see one.
 *
 * `toolContractProblems` holds the part of that which a program can decide:
 *
 *   - `name` is lower snake case and carries the server's prefix.
 *   - `title` and `description` are present and no two tools share either.
 *   - `description` stays within a length a model reads whole.
 *   - every argument, nested ones included, has a description.
 *   - `outputSchema` is present, so a result can be validated.
 *   - all four behaviour hints are stated. Two of them default to true when absent
 *     (`destructiveHint`, `openWorldHint`), so a read-only tool that omits them tells a client it
 *     may destroy data.
 *   - every tool named in any text the server sends is a tool the server lists. A mount that drops
 *     the paying tools must not keep a sentence that sends its caller to one. Any lower snake case
 *     word that starts with the prefix is read as a tool name, so tool text keeps that prefix for
 *     tools alone.
 *   - on a server with more than one tool, each description names a sibling.
 *
 * The rest is judgement, and the order above is what that judgement is held to.
 */

/**
 * Names tools in a sentence, keeping only the ones a server lists. `named("a", "b")` is "a or b",
 * "a" when only one is listed and "" when neither is, so the caller writes the fallback. Every tool
 * name that reaches a description goes through one of these, which is what makes the "names only
 * listed tools" rule hold by construction on a server whose tools vary by setting.
 */
export interface ToolNamer {
  (...names: string[]): string;
  /** Whether `name` is listed. */
  lists(name: string): boolean;
}

/** A namer over `listed`. Null lists everything: a server with no allowlist. */
export function toolNamer(listed: Iterable<string> | null): ToolNamer {
  const set = listed === null ? null : new Set(listed);
  const lists = (name: string): boolean => set === null || set.has(name);
  const named = (...names: string[]): string => {
    const kept = names.filter(lists);
    return kept.length < 2 ? (kept[0] ?? "") : `${kept.slice(0, -1).join(", ")} or ${kept.at(-1)}`;
  };
  return Object.assign(named, { lists });
}

/** A JSON Schema node as `tools/list` carries it. Only the keys the walk reads are named. */
export interface SchemaNode {
  description?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode | SchemaNode[];
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
  additionalProperties?: boolean | SchemaNode;
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
  definitions?: Record<string, SchemaNode>;
  [key: string]: unknown;
}

/** One entry of a `tools/list` result. */
export interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: SchemaNode;
  outputSchema?: SchemaNode;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ToolContractOptions {
  /** The prefix every tool name carries, underscore included. It is also how a tool is recognised
   *  when text mentions one. */
  prefix: string;
  /** The server's `instructions`, checked for tools it names. */
  instructions?: string;
  /** Longest description allowed, in characters. */
  maxDescriptionChars?: number;
}

/** The default ceiling on a description. About 170 words: room for the four parts, none for a manual. */
export const MAX_TOOL_DESCRIPTION_CHARS = 1000;

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;
const NAME_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

const BRANCHES = ["anyOf", "oneOf", "allOf"] as const;

/** `node`, or the definition a local `$ref` on it points at. A reference that resolves nowhere, or
 *  back to a node already being read, yields nothing: the walk reads what the listing carries. */
function resolve(node: SchemaNode, root: SchemaNode, seen: Set<SchemaNode>): SchemaNode | null {
  if (seen.has(node)) return null;
  seen.add(node);
  const ref = /^#\/(\$defs|definitions)\/(.+)$/.exec(node.$ref ?? "");
  if (!ref) return node;
  const target = (ref[1] === "$defs" ? root.$defs : root.definitions)?.[ref[2]!];
  return target ? resolve(target, root, seen) : null;
}

/** Whether a property says what it is: on itself, or on every branch when it is a choice of shapes. */
function described(node: SchemaNode): boolean {
  if (node.description?.trim()) return true;
  const branches = BRANCHES.flatMap((key) => node[key] ?? []);
  return branches.length > 0 && branches.every(described);
}

/** Every description string in a schema, at any depth. */
function schemaText(start: SchemaNode | undefined, root = start, seen = new Set<SchemaNode>()): string[] {
  const node = start && root ? resolve(start, root, seen) : null;
  if (!node || !root) return [];
  const out = node.description ? [node.description] : [];
  for (const prop of Object.values(node.properties ?? {})) out.push(...schemaText(prop, root, seen));
  for (const item of Array.isArray(node.items) ? node.items : node.items ? [node.items] : []) out.push(...schemaText(item, root, seen));
  for (const branch of BRANCHES.flatMap((key) => node[key] ?? [])) out.push(...schemaText(branch, root, seen));
  if (node.additionalProperties && typeof node.additionalProperties === "object") out.push(...schemaText(node.additionalProperties, root, seen));
  return out;
}

/** The path of every property that has no description, at any depth: `a.b` for a nested object,
 *  `a[].b` for one inside an array. */
function undescribed(start: SchemaNode | undefined, path = "", root = start, seen = new Set<SchemaNode>()): string[] {
  const node = start && root ? resolve(start, root, seen) : null;
  if (!node || !root) return [];
  const out: string[] = [];
  for (const [key, prop] of Object.entries(node.properties ?? {})) {
    const here = path ? `${path}.${key}` : key;
    if (!described(resolve(prop, root, new Set(seen)) ?? prop)) out.push(here);
    out.push(...undescribed(prop, here, root, seen));
  }
  for (const item of Array.isArray(node.items) ? node.items : node.items ? [node.items] : []) out.push(...undescribed(item, `${path}[]`, root, seen));
  // A branch is another shape of the same value, so its properties keep the same path.
  for (const branch of BRANCHES.flatMap((key) => node[key] ?? [])) out.push(...undescribed(branch, path, root, seen));
  if (node.additionalProperties && typeof node.additionalProperties === "object") out.push(...undescribed(node.additionalProperties, `${path}.*`, root, seen));
  return out;
}

/**
 * Every way `tools` breaks the contract, one sentence each, the tool named first. Empty means the
 * definitions hold. Pass the tools exactly as `tools/list` returned them.
 */
export function toolContractProblems(tools: readonly ListedTool[], opts: ToolContractOptions): string[] {
  const max = opts.maxDescriptionChars ?? MAX_TOOL_DESCRIPTION_CHARS;
  const served = new Set(tools.map((t) => t.name));
  const prefix = opts.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(`\\b${prefix}[a-z0-9]+(?:_[a-z0-9]+)*\\b`, "g");
  const mentioned = (text: string): string[] => [...new Set(text.match(mention) ?? [])];
  const problems: string[] = [];

  const seenTitle = new Map<string, string>();
  const seenDescription = new Map<string, string>();

  for (const tool of tools) {
    const say = (problem: string): void => void problems.push(`${tool.name}: ${problem}`);
    const description = tool.description?.trim() ?? "";
    const title = (tool.title ?? tool.annotations?.title)?.trim() ?? "";

    if (!NAME_SHAPE.test(tool.name)) say("the name is not lower snake case");
    if (!tool.name.startsWith(opts.prefix)) say(`the name does not start with ${opts.prefix}`);

    if (!title) say("no title");
    else if (seenTitle.has(title)) say(`shares its title with ${seenTitle.get(title)}`);
    else seenTitle.set(title, tool.name);

    if (!description) say("no description");
    else {
      if (seenDescription.has(description)) say(`shares its description with ${seenDescription.get(description)}`);
      else seenDescription.set(description, tool.name);
      if (description.length > max) say(`the description is ${description.length} characters, over the ${max} allowed`);
      if (served.size > 1 && !mentioned(description).some((name) => name !== tool.name && served.has(name))) {
        say("the description names no sibling tool, so it does not say when to call another one");
      }
    }

    for (const path of undescribed(tool.inputSchema)) say(`argument ${path} has no description`);
    if (!tool.outputSchema) say("no outputSchema");

    for (const hint of HINTS) {
      if (typeof tool.annotations?.[hint] !== "boolean") say(`${hint} is not stated`);
    }
    if (tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === true) {
      say("readOnlyHint and destructiveHint are both true");
    }

    const text = [description, ...schemaText(tool.inputSchema), ...schemaText(tool.outputSchema)].join("\n");
    for (const name of mentioned(text)) {
      if (!served.has(name)) say(`its text names ${name}, which this server does not list`);
    }
  }

  for (const name of mentioned(opts.instructions ?? "")) {
    if (!served.has(name)) problems.push(`instructions: names ${name}, which this server does not list`);
  }
  return problems;
}
