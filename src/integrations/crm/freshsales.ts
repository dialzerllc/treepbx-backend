import type { CrmAdapter, CrmContact } from './base';

export class FreshsalesAdapter implements CrmAdapter {
  name = 'freshsales';
  private apiKey = '';

  async authenticate(credentials: Record<string, unknown>) {
    this.apiKey = credentials.apiKey as string;
  }

  async fetchContacts(): Promise<CrmContact[]> { return []; }
  async pushContact(contact: CrmContact): Promise<string> { return ''; }
  async pushCallLog(callData: Record<string, unknown>): Promise<void> {}
}
