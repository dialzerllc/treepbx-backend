import type { CrmAdapter, CrmContact } from './base';

export class ZohoAdapter implements CrmAdapter {
  name = 'zoho';
  private accessToken = '';

  async authenticate(credentials: Record<string, unknown>) {
    this.accessToken = credentials.accessToken as string;
  }

  async fetchContacts(): Promise<CrmContact[]> { return []; }
  async pushContact(contact: CrmContact): Promise<string> { return ''; }
  async pushCallLog(callData: Record<string, unknown>): Promise<void> {}
}
