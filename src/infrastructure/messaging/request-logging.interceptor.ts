import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { finalize, type Observable } from 'rxjs';

interface HttpRequestContext {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown>;
}
interface HttpResponseContext { statusCode: number }

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<HttpRequestContext>();
    const res = context.switchToHttp().getResponse<HttpResponseContext>();
    const started = Date.now();
    return next.handle().pipe(finalize(() => {
      // Sem payloads financeiros, senhas, tokens ou Idempotency-Key nos logs.
      const correlationId = req.headers['x-correlation-id'];
      console.log(JSON.stringify({
        event: 'http.request', method: req.method, route: req.url.split('?')[0],
        statusCode: res.statusCode, durationMs: Date.now() - started,
        correlationId: typeof correlationId === 'string' ? correlationId : undefined,
        providerId: typeof req.body?.providerId === 'string' ? req.body.providerId : undefined,
        walletId: typeof req.body?.walletId === 'string' ? req.body.walletId : undefined,
        externalTransactionId: typeof req.body?.externalTransactionId === 'string' ? req.body.externalTransactionId : undefined,
      }));
    }));
  }
}
