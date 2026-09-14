export const zeissConfig = {
  get ordersBaseUrl(): string {
    const url = process.env.ZEISS_ORDERS_BASE_URL;
    if (!url && process.env.NODE_ENV !== 'test') throw new Error('ZEISS configuration missing: ZEISS_ORDERS_BASE_URL');
    return url || '';
  },
  get trackingBaseUrl(): string {
    const url = process.env.ZEISS_TRACKING_BASE_URL;
    if (!url && process.env.NODE_ENV !== 'test') throw new Error('ZEISS configuration missing: ZEISS_TRACKING_BASE_URL');
    return url || '';
  },
  get campaignsBaseUrl(): string {
    const url = process.env.ZEISS_CAMPAIGNS_BASE_URL;
    if (!url && process.env.NODE_ENV !== 'test') throw new Error('ZEISS configuration missing: ZEISS_CAMPAIGNS_BASE_URL');
    return url || '';
  },
  get financialBaseUrl(): string {
    const url = process.env.ZEISS_FINANCIAL_BASE_URL;
    if (!url && process.env.NODE_ENV !== 'test') throw new Error('ZEISS configuration missing: ZEISS_FINANCIAL_BASE_URL');
    return url || '';
  },
  get servicesBaseUrl(): string {
    const url = process.env.ZEISS_SERVICES_BASE_URL;
    if (!url && process.env.NODE_ENV !== 'test') throw new Error('ZEISS configuration missing: ZEISS_SERVICES_BASE_URL');
    return url || '';
  },
  get apiKey(): string {
    const key = process.env.ZEISS_API_KEY;
    if (!key && process.env.NODE_ENV !== 'test') {
      throw new Error('ZEISS configuration missing: ZEISS_API_KEY');
    }
    return key || '';
  },
  get countryId(): string {
    const cid = process.env.ZEISS_COUNTRY_ID;
    if (!cid && process.env.NODE_ENV !== 'test') {
      throw new Error('ZEISS configuration missing: ZEISS_COUNTRY_ID');
    }
    return cid || '';
  },
  get cnpj(): string {
    const cnpj = process.env.ZEISS_CNPJ;
    if (!cnpj && process.env.NODE_ENV !== 'test') {
      throw new Error('ZEISS configuration missing: ZEISS_CNPJ');
    }
    return cnpj || '';
  },
  get storeId(): string {
    const storeId = process.env.ZEISS_STORE_ID;
    if (!storeId && process.env.NODE_ENV !== 'test') {
      throw new Error('ZEISS configuration missing: ZEISS_STORE_ID');
    }
    return storeId || '';
  },
  get saowebCode(): string {
    const code = process.env.ZEISS_SAOWEB_CODE;
    if (!code && process.env.NODE_ENV !== 'test') throw new Error('ZEISS configuration missing: ZEISS_SAOWEB_CODE');
    return code || '';
  },
  get voucherUserId(): string {
    const id = process.env.ZEISS_VOUCHER_USER_ID;
    if (!id && process.env.NODE_ENV !== 'test') throw new Error('ZEISS configuration missing: ZEISS_VOUCHER_USER_ID');
    return id || '';
  },
  get finUserId(): string {
    const id = process.env.ZEISS_FIN_USER_ID;
    if (!id && process.env.NODE_ENV !== 'test') throw new Error('ZEISS configuration missing: ZEISS_FIN_USER_ID');
    return id || '';
  }
};
