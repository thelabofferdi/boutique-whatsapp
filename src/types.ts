/** Types partagés par le Worker, le CLI, le banc de comparaison et les tests. */

export type Category = "pagne" | "bazin" | "accessoire" | "chaussure";

export type Product = {
  id: string;
  name: string;
  category: Category;
  price_xof: number;
  stock: number;
  unit_weight_kg: number;
  colors: string[];
  description: string;
  tags: string[];
};

export type OrderLine = {
  product_id: string;
  name: string;
  quantity: number;
  unit_price_xof: number;
  line_total_xof: number;
  /** Couleur ou taille choisie par le client, telle qu'il l'a dite. */
  variant?: string;
};

export type OrderStatus =
  | "brouillon" // préparé, en attente du « oui » du client
  | "attente_gerante" // client OK, la gérante doit valider sur WhatsApp
  | "confirmee" // gérante OK, stock décrémenté
  | "refusee" // gérante a refusé
  | "expiree"; // réservation expirée

export type Order = {
  id: string;
  code: string;
  chat_id: string;
  customer_name: string;
  customer_phone: string;
  zone: string;
  lines: OrderLine[];
  subtotal_xof: number;
  delivery_xof: number;
  total_xof: number;
  currency: string;
  total_converted: number | null;
  rate_used: number | null;
  status: OrderStatus;
  created_at: string;
  reserved_until: string;
  confirmed_at?: string;
  manager_note?: string;
  history: { at: string; event: string; by: string }[];
};

export type DeliveryQuote = {
  zone: string;
  label: string;
  fee_xof: number;
  eta: string;
  free: boolean;
  note?: string;
};

export type Conversion = {
  amount_xof: number;
  currency: string;
  amount: number;
  rate: number;
  as_of: string;
  source: string;
};

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

export type TraceStep = {
  n: number;
  at: string;
  ms: number;
  kind: "llm" | "tool";
  name: string;
  input?: unknown;
  output?: unknown;
  tokens_in?: number;
  tokens_out?: number;
  agent?: string;
};

export type Trace = {
  id: string;
  scenario?: string;
  architecture: "solo" | "equipe";
  started_at: string;
  duration_ms: number;
  steps: TraceStep[];
  tokens_in: number;
  tokens_out: number;
  cost_rodi: number;
  cost_xof: number;
  reply: string;
  checks: CheckResult[];
};

export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

export type Usage = { input_tokens: number; output_tokens: number };
