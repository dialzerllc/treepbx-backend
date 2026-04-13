import type { CrmAdapter, CrmContact } from './base';

export class SalesforceAdapter implements CrmAdapter {
  name = 'salesforce';
  private accessToken = '';
  private instanceUrl = '';

  async authenticate(credentials: Record<string, unknown>) {
    // OAuth2 token exchange
    // TODO: implement Salesforce OAuth2 flow
    this.accessToken = credentials.accessToken as string;
    this.instanceUrl = credentials.instanceUrl as string;
  }

  async fetchContacts(since?: Date): Promise<CrmContact[]> {
    // TODO: SOQL query against Salesforce Contact/Lead objects
    return [];
  }

  async pushContact(contact: CrmContact): Promise<string> {
    // TODO: POST to /services/data/v58.0/sobjects/Contact
    return '';
  }

  async pushCallLog(callData: Record<string, unknown>): Promise<void> {
    // TODO: POST to /services/data/v58.0/sobjects/Task
  }
}
