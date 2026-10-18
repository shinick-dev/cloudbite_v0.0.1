// Shared wire format for Cloudbite's own access request flow; no credentials in these views.
export interface CloudbiteAccessRequest {
  id: string;
  name: string;
  purpose: string;
  status: 'pending' | 'approved' | 'denied' | 'revoked' | 'expired';
  createdAt: number;
  expiresAt: number;
  maxExperts: number;
  maxProjects: number;
  usedProjects: number;
}
export interface CloudbiteAccessSession {
  request: CloudbiteAccessRequest | null;
  canCreate: boolean;
}
