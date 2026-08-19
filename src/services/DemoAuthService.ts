import type { AuthUser, IAuthService } from './IAuthService';

const DEMO_USER: AuthUser = {
  id: 'demo-operator',
  email: 'operator@demo.local',
  name: 'Demo operator',
};

export class DemoAuthService implements IAuthService {
  readonly fabricAuthEnabled = false;

  async signIn(): Promise<AuthUser> {
    return DEMO_USER;
  }

  async signOut(): Promise<void> {}

  async getCurrentUser(): Promise<AuthUser> {
    return DEMO_USER;
  }

  async initEmbeddedAuth(): Promise<null> {
    return null;
  }
}