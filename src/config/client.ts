import { zeissConfig } from './config';

export class ZeissHttpError extends Error {
  constructor(public status: number, public statusText: string, public body: string) {
    super(`ZEISS API Error: ${status} ${statusText}`);
    this.name = 'ZeissHttpError';
  }
}

export interface ZeissRequestOptions extends RequestInit {
  apiKey?: string;
}

export class ZeissApiClient {
  async fetch<T>(baseUrl: string, path: string, options?: ZeissRequestOptions): Promise<T> {
    const url = `${baseUrl}${path}`;
    const apiKey = options?.apiKey || zeissConfig.apiKey;
    
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      ...(options?.headers || {}),
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      let errBody = '';
      try { errBody = await response.text(); } catch(e){}
      throw new ZeissHttpError(response.status, response.statusText, errBody);
    }

    // In some cases, response might be empty or not JSON, but we assume JSON for the MVP.
    const data = await response.json();
    return data as T;
  }
}
