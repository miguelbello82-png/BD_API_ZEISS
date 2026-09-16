// ============================================================
// Types — BD_API_ZEISS Platform
// ============================================================
// Neutral DTOs used across contracts and engine layers.
// ============================================================

export interface OrderStateInput {
  status: string | null;
  codsit: string | null;
  detail_status?: string | null;
}

export interface TrackingStateInput {
  status_aprovada: string | null;
  status_inicio: string | null;
  status_chegada: string | null;
  status_entrega: string | null;
  data_entrega: string | null;
}

export interface OrderCandidate {
  order_id: string;
  order_number: string;
  raw_status: string | null;
  raw_codsit: string | null;
  detail_status?: string | null;
}

export interface OrderRecord {
  order_number: string;
  os_number: string;
  status: string | null;
  codsit: string | null;
  entry_date?: string | null;
  expected_date?: string | null;
  created_at?: Date;
  updated_at?: Date;
}

export interface InvoiceReference {
  number: string;
  series: string | null;
}

export interface OrderDetailRecord {
  order_number: string;
  situacao: string | null;
  status: string | null;
  entry_date?: string | null;
  expected_date?: string | null;
  invoices: InvoiceReference[];
}

export interface TrackingCandidate {
  order_id: string;
  order_number: string;
  raw_order_status: string | null;
  raw_order_codsit: string | null;
  detail_status?: string | null;
  nf_number: string;
  tracking_state: TrackingStateInput | null;
}

export interface TrackingEventRecord {
  status: string | null;
  data: string | null;
  status_aprovada: string | null;
  status_inicio: string | null;
  status_chegada: string | null;
  status_entrega: string | null;
  data_entrega: string | null;
}

export interface DateSlice {
  startDate: string;
  endDate: string;
}

export interface ProductRecord {
  product_id: string;
  name: string | null;
  sku: string | null;
  group: string | null;
  family: string | null;
}

export interface CampaignRecord {
  campaign_id: string;
  title: string | null;
  slogan: string | null;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string | null;
  aceite: boolean | null;
  incentive_type: string | null;
}

export interface LeadRecord {
  lead_id: string;
  campaign_id: string;
  cpf_hmac: string | null;
  status: string | null;
  voucher_code: string | null;
}

export interface ReceivableRecord {
  boleto_number: string;
  fiscal_reference: string | null;
  emission_date: string | null;
  due_date: string | null;
  amount: string | null; // Decimal string
  status: string | null;
  order_id?: string;
}
