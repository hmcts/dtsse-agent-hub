/** A person as the hub knows them: the Entra object id and tenant, and what to print. */
export interface Identity {
  oid: string;
  tid: string;
  name: string;
  email?: string;
}
