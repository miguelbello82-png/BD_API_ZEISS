import { zeissConfig } from './config';

export class ZeissApiClient {
  async fetch<T>(baseUrl: string, path: string, options?: RequestInit): Promise<T> {
    const url = `${baseUrl}${path}`;
    
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': zeissConfig.apiKey,
      ...(options?.headers || {}),
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      let errBody = '';
      try { errBody = await response.text(); } catch(e){}
      throw new Error(`ZEISS API Error: ${response.status} ${response.statusText} - ${errBody}`);
    }

    // In some cases, response might be empty or not JSON, but we assume JSON for the MVP.
    const data = await response.json();
    return data as T;
  }
}
