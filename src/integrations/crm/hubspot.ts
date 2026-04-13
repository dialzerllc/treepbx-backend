import type { CrmAdapter, CrmContact } from './base';

export class HubSpotAdapter implements CrmAdapter {
  name = 'hubspot';
  private accessToken = '';

  async authenticate(credentials: Record<string, unknown>) {
    this.accessToken = credentials.accessToken as string;
  }

  async fetchContacts(since?: Date): Promise<CrmContact[]> {
    // TODO: GET /crm/v3/objects/contacts
    return [];
  }

  async pushContact(contact: CrmContact): Promise<string> {
    // TODO: POST /crm/v3/objects/contacts
    return '';
  }

  async pushCallLog(callData: Record<string, unknown>): Promise<void> {
    // TODO: POST /crm/v3/objects/calls
  }
}
