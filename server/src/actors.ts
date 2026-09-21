import type { UserRole } from './domain.js';

export type UserActor = {
  kind: 'user';
  userId: string;
  role: UserRole;
  email: string;
  name: string;
};

export type InstallationActor = {
  kind: 'installation';
  installationId: string;
};

export type Actor = UserActor | InstallationActor;

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}
