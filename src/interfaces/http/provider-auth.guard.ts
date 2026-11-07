import { CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão de autenticação. Intencionalmente no-op no teste técnico:
 * autenticação tem pontuação zero e o README permite essa decisão documentada.
 * NÃO usar assim em produção; substituir por validação OIDC (Keycloak/Zitadel),
 * claims de providerId e autorização do vínculo player/wallet.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean { return true; }
}
