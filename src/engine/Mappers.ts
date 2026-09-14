import { OrderRecord, OrderDetailRecord, TrackingEventRecord, InvoiceReference, CampaignRecord, LeadRecord, ReceivableRecord, ProductRecord } from '../contracts/types';

export class ContractMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractMappingError';
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
      start_date: typeof rawObj.datainicial === 'string' ? rawObj.datainicial : null, // source: datainicial
      end_date: typeof rawObj.datafinal === 'string' ? rawObj.datafinal : null, // source: datafinal
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

    return {
      boleto_number: boleto,
      fiscal_reference: typeof rawObj.identificadornf === 'string' ? rawObj.identificadornf : null,
      emission_date: typeof rawObj.emissao === 'string' ? rawObj.emissao : null,
      due_date: typeof rawObj.vencimento === 'string' ? rawObj.vencimento : (typeof rawObj.vencimentoqad === 'string' ? rawObj.vencimentoqad : null),
      amount: amountString,
      status: typeof rawObj.status === 'string' ? rawObj.status : null,
      order_id: undefined // mapped later by joining against fiscal_documents if needed
    };
  }
}
