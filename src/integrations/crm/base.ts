export interface CrmContact {
  externalId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone: string;
  company?: string;
}

export interface CrmAdapter {
  name: string;
  authenticate(credentials: Record<string, unknown>): Promise<void>;
  fetchContacts(since?: Date): Promise<CrmContact[]>;
  pushContact(contact: CrmContact): Promise<string>;
  pushCallLog(callData: Record<string, unknown>): Promise<void>;
}
