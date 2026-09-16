import { OrderRecord, OrderDetailRecord, TrackingEventRecord, InvoiceReference, CampaignRecord, LeadRecord, ReceivableRecord, ProductRecord } from '../contracts/types';

export class ContractMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractMappingError';
  }
}

export class DateParser {
  static parse(val: unknown, format: 'YYYY-MM-DD' | 'MM/DD/YYYY', domain: string): string | null {
    if (typeof val !== 'string' || val.trim() === '') return null;
    const str = val.trim();

    let year: number, month: number, day: number;

    if (format === 'YYYY-MM-DD') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        throw new ContractMappingError(`${domain} Contract Violation: Invalid date format received: '${str}' (expected YYYY-MM-DD)`);
      }
      const parts = str.split('-');
      year = parseInt(parts[0], 10);
      month = parseInt(parts[1], 10);
      day = parseInt(parts[2], 10);
    } else { // MM/DD/YYYY
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
        throw new ContractMappingError(`${domain} Contract Violation: Invalid date format received: '${str}' (expected MM/DD/YYYY)`);
      }
      const parts = str.split('/');
      month = parseInt(parts[0], 10);
      day = parseInt(parts[1], 10);
      year = parseInt(parts[2], 10);
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new ContractMappingError(`${domain} Contract Violation: Impossible date received: '${str}'`);
    }

    // Construct UTC date and verify strict calendar correctness to prevent silent rollover
    const dateObj = new Date(Date.UTC(year, month - 1, day));
    if (
      dateObj.getUTCFullYear() !== year ||
      dateObj.getUTCMonth() !== month - 1 ||
      dateObj.getUTCDate() !== day
    ) {
      throw new ContractMappingError(`${domain} Contract Violation: Impossible date received: '${str}'`);
    }

    const yy = String(year).padStart(4, '0');
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }
}

// ============================================================
// DATA MINIMIZATION: ORD-001 (Order Discovery)
// ============================================================

export class OrdersMapper {
  static normalizeOrderListItem(raw: unknown): OrderRecord {
    if (!raw || typeof raw !== 'object') {
      throw new ContractMappingError('Invalid payload: expected object');
    }

    const rawObj = raw as Record<string, unknown>;

    if (typeof rawObj['nr-pedido'] !== 'string' || rawObj['nr-pedido'].trim() === '') {
      throw new ContractMappingError('Order missing required nr-pedido identifier');
    }

    return {
      order_number: rawObj['nr-pedido'],
      os_number: typeof rawObj['os-cliente'] === 'string' || typeof rawObj['os-cliente'] === 'number'
        ? String(rawObj['os-cliente']) : '',
      status: typeof rawObj.status === 'string' ? rawObj.status : null,
      codsit: typeof rawObj.codsit === 'string' ? rawObj.codsit : null,
      entry_date: DateParser.parse(rawObj['data-entrada'], 'YYYY-MM-DD', 'ORD-001'),
      expected_date: DateParser.parse(rawObj['previsao-entrega'], 'YYYY-MM-DD', 'ORD-001'),
    };
  }
}

// ============================================================
// DATA MINIMIZATION: ORD-002 (Order Detail)
// ============================================================

export class OrderDetailMapper {
  static minimize(orderNumber: string, raw: unknown): OrderDetailRecord {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ContractMappingError('Invalid order detail payload');
    }

    const rawObj = raw as Record<string, unknown>;

    // Validate structurally it looks like an order detail (has status, situacao, or nf)
    if (!('situacao' in rawObj) && !('status' in rawObj) && !('nf' in rawObj)) {
      throw new ContractMappingError('Payload structurally invalid, missing known detail fields');
    }

    const invoices: InvoiceReference[] = [];
    if ('nf' in rawObj) {
      if (!Array.isArray(rawObj.nf)) {
        throw new ContractMappingError('Invalid invoice format: nf must be an array');
      }
      for (const item of rawObj.nf) {
        if (item && typeof item === 'object') {
          const inv = item as Record<string, unknown>;
          if (typeof inv.nr === 'string' && inv.nr.trim() !== '') {
            invoices.push({
              number: inv.nr.trim(),
              series: typeof inv.serie === 'string' ? inv.serie.trim() : null,
            });
          }
        }
      }
    }

    return {
      order_number: orderNumber,
      situacao: typeof rawObj.situacao === 'string' ? rawObj.situacao : null,
      status: typeof rawObj.status === 'string' ? rawObj.status : null,
      entry_date: rawObj.entrada && typeof rawObj.entrada === 'object' && 'data' in rawObj.entrada
        ? DateParser.parse((rawObj.entrada as any).data, 'MM/DD/YYYY', 'ORD-002')
        : null,
      expected_date: DateParser.parse(rawObj.previsao, 'YYYY-MM-DD', 'ORD-002'),
      invoices,
    };
  }
}

// ============================================================
// DATA MINIMIZATION: TRK-001 (Tracking)
// ============================================================

export class TrackingMapper {
  static minimize(raw: unknown): TrackingEventRecord[] {
    if (!Array.isArray(raw)) {
      throw new ContractMappingError('Tracking response must be an array of events according to the canonical contract');
    }

    const eventsArray: unknown[] = raw;
    const result: TrackingEventRecord[] = [];

    for (const evt of eventsArray) {
      if (!evt || typeof evt !== 'object') continue;

      const evtObj = evt as Record<string, unknown>;

      result.push({
        status: typeof evtObj.status === 'string' ? evtObj.status : (typeof evtObj.situacao === 'string' ? evtObj.situacao : null),
        data: typeof evtObj.data === 'string' ? evtObj.data : null,
        status_aprovada: typeof evtObj.status_aprovada === 'string' ? evtObj.status_aprovada : null,
        status_inicio: typeof evtObj.status_inicio === 'string' ? evtObj.status_inicio : null,
        status_chegada: typeof evtObj.status_chegada === 'string' ? evtObj.status_chegada : null,
        status_entrega: typeof evtObj.status_entrega === 'string' ? evtObj.status_entrega : null,
        data_entrega: typeof evtObj.data_entrega === 'string' ? evtObj.data_entrega : null,
      });
    }

    return result;
  }
}

// ============================================================
// DATA MINIMIZATION: CAM-001 (Campaigns)
// ============================================================

export class CampaignMapper {
  private static parseZeissDate(val: unknown): string | null {
    if (typeof val !== 'string' || val.trim() === '') return null;
    const parts = val.trim().split('-');
    if (parts.length !== 3 || parts[0].length !== 2 || parts[1].length !== 2 || parts[2].length !== 4) {
      throw new ContractMappingError(`Invalid CAM-001 date format: expected DD-MM-YYYY, got ${val}`);
    }
    // Return YYYY-MM-DD
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }

  static normalize(raw: unknown): CampaignRecord {
    if (!raw || typeof raw !== 'object') {
      throw new ContractMappingError('Invalid campaign payload: expected object');
    }

    const rawObj = raw as Record<string, unknown>;

    if (typeof rawObj.idcampanha !== 'string' && typeof rawObj.idcampanha !== 'number') {
      throw new ContractMappingError('Campaign missing required idcampanha identifier');
    }

    return {
      campaign_id: String(rawObj.idcampanha), // source: idcampanha
      title: typeof rawObj.titulo === 'string' ? rawObj.titulo : null, // source: titulo
      slogan: typeof rawObj.slogan === 'string' ? rawObj.slogan : null, // source: slogan
      description: typeof rawObj.descricao === 'string' ? rawObj.descricao : null, // source: descricao
      start_date: CampaignMapper.parseZeissDate(rawObj.datainicial), // source: datainicial
      end_date: CampaignMapper.parseZeissDate(rawObj.datafinal), // source: datafinal
      status: typeof rawObj.ativosn === 'string' ? rawObj.ativosn : null, // source: ativosn
      aceite: typeof rawObj.aceite === 'boolean' ? rawObj.aceite : null, // source: aceite
      incentive_type: typeof rawObj.incentivo === 'string' ? rawObj.incentivo : null, // source: incentivo
    };
  }
}

// ============================================================
// DATA MINIMIZATION: LEAD-001 / LEAD-002 (Leads)
// ============================================================

export class LeadMapper {
  static normalize(raw: unknown): LeadRecord {
    if (!raw || typeof raw !== 'object') {
      throw new ContractMappingError('Invalid lead payload: expected object');
    }

    const rawObj = raw as Record<string, unknown>;

    if (typeof rawObj.id_lead !== 'string' && typeof rawObj.id_lead !== 'number') {
      throw new ContractMappingError('Lead missing required id_lead identifier');
    }

    return {
      lead_id: String(rawObj.id_lead),
      campaign_id: typeof rawObj.id_campanha === 'string' || typeof rawObj.id_campanha === 'number' ? String(rawObj.id_campanha) : '',
      cpf_hmac: null, // As per C2.8-R3, do not read cpf_hmac from ZEISS raw payload
      status: typeof rawObj.status === 'string' ? rawObj.status : null,
      voucher_code: typeof rawObj.voucher === 'string' ? rawObj.voucher : null,
    };
  }
}

// ============================================================
// DATA MINIMIZATION: PRD-001 (Products)
// ============================================================

export class ProductMapper {
  static normalize(raw: unknown): ProductRecord {
    if (!raw || typeof raw !== 'object') {
      throw new ContractMappingError('Invalid product payload: expected object');
    }

    const rawObj = raw as Record<string, unknown>;

    // Proven PRD-001 identifier (cod is numeric)
    const productId = typeof rawObj.cod === 'number' ? String(rawObj.cod) : (typeof rawObj.cod === 'string' ? rawObj.cod : null);
    if (!productId) {
      throw new ContractMappingError('Product missing required identifier');
    }

    return {
      product_id: productId,
      name: typeof rawObj.desc === 'string' ? rawObj.desc : null,
      sku: null,
      group: null,
      family: null,
    };
  }
}

// ============================================================
// DATA MINIMIZATION: FIN-001 (Receivables)
// ============================================================

export class ReceivableMapper {
  private static parseZeissDate(val: unknown): string | null {
    if (typeof val !== 'string' || val.trim() === '') return null;
    const str = val.trim();
    // Receivable format is ambiguous? Actually it was validating both YYYY-MM-DD and DD/MM/YYYY.
    // I will replace it to use DateParser or keep its dual-logic because FIN-001 evidence has both.
    // Wait, the user asked me to keep FIN-001 strict to what it was.
    // I'll keep FIN-001 logic exactly as is here to avoid breaking it, but I'll use the DateParser internally for YYYY-MM-DD.
    let year: number, month: number, day: number;

    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const parts = str.split('-');
      year = parseInt(parts[0], 10);
      month = parseInt(parts[1], 10);
      day = parseInt(parts[2], 10);
    }
    else if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
      const parts = str.split('/');
      day = parseInt(parts[0], 10);
      month = parseInt(parts[1], 10);
      year = parseInt(parts[2], 10);
    } else {
      throw new ContractMappingError(`FIN-001 Contract Violation: Invalid date format received from source: '${str}'`);
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new ContractMappingError(`FIN-001 Contract Violation: Impossible date received from source: '${str}'`);
    }

    const dateObj = new Date(Date.UTC(year, month - 1, day));
    if (
      dateObj.getUTCFullYear() !== year ||
      dateObj.getUTCMonth() !== month - 1 ||
      dateObj.getUTCDate() !== day
    ) {
      throw new ContractMappingError(`FIN-001 Contract Violation: Impossible date received from source: '${str}'`);
    }

    const yy = String(year).padStart(4, '0');
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  static normalize(raw: unknown): ReceivableRecord {
    if (!raw || typeof raw !== 'object') {
      throw new ContractMappingError('Invalid receivable payload: expected object');
    }

    const rawObj = raw as Record<string, unknown>;

    // We use the fields proven in evidence (boleto, emissao, vencimento, valor, status, etc)
    const boleto = typeof rawObj.boleto === 'string' ? rawObj.boleto : (typeof rawObj.numeroboleto === 'string' ? rawObj.numeroboleto : (typeof rawObj.identificadorboleto === 'string' ? rawObj.identificadorboleto : null));
    if (!boleto) {
      throw new ContractMappingError('Receivable missing required boleto identifier');
    }

    // Process money safely without binary float conversion
    let amountString: string | null = null;
    if (typeof rawObj.valor === 'number') {
      throw new ContractMappingError('FIN-001 Contract Violation: Expected decimal string for money, received JSON number');
    } else if (typeof rawObj.valor === 'string') {
      // Validate it looks like a number string
      if (/^-?\d+(\.\d+)?$/.test(rawObj.valor.trim())) {
        amountString = rawObj.valor.trim();
      } else {
        throw new ContractMappingError('FIN-001 Contract Violation: Invalid decimal string format for money');
      }
    }

    let emission: string | null = null;
    if (typeof rawObj.emissao === 'string' && rawObj.emissao.trim() !== '') {
      try {
        emission = ReceivableMapper.parseZeissDate(rawObj.emissao);
      } catch (err) {
        throw new ContractMappingError(`FIN-001 Contract Violation: Invalid emission_date received from source: '${rawObj.emissao}'`);
      }
    }

    let due: string | null = null;
    const rawDue = typeof rawObj.vencimento === 'string' && rawObj.vencimento.trim() !== '' ? rawObj.vencimento :
                  (typeof rawObj.vencimentoqad === 'string' && rawObj.vencimentoqad.trim() !== '' ? rawObj.vencimentoqad : null);

    if (rawDue) {
      try {
        due = ReceivableMapper.parseZeissDate(rawDue);
      } catch (err) {
        throw new ContractMappingError(`FIN-001 Contract Violation: Invalid due_date received from source: '${rawDue}'`);
      }
    }

    return {
      boleto_number: boleto,
      fiscal_reference: typeof rawObj.identificadornf === 'string' ? rawObj.identificadornf : null,
      emission_date: emission,
      due_date: due,
      amount: amountString,
      status: typeof rawObj.status === 'string' ? rawObj.status : null,
      order_id: undefined // mapped later by joining against fiscal_documents if needed
    };
  }
}
