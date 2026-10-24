export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RouteMatch {
  params: Record<string, string>;
}

interface RegisteredRoute<TContext, TResult> {
  method: HttpMethod;
  segments: string[];
  handler: (ctx: TContext, match: RouteMatch) => TResult | Promise<TResult>;
}

/**
 * Deliberately minimal path router (param segments only, no wildcards/regex)
 * — the Core's route table is small and fixed, so a dependency like
 * express/koa would add bundle size and attack surface without buying
 * anything the spec needs.
 */
export class Router<TContext, TResult> {
  private routes: RegisteredRoute<TContext, TResult>[] = [];

  add(method: HttpMethod, pattern: string, handler: (ctx: TContext, match: RouteMatch) => TResult | Promise<TResult>): void {
    this.routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
  }

  get(pattern: string, handler: (ctx: TContext, match: RouteMatch) => TResult | Promise<TResult>): void {
    this.add('GET', pattern, handler);
  }
  post(pattern: string, handler: (ctx: TContext, match: RouteMatch) => TResult | Promise<TResult>): void {
    this.add('POST', pattern, handler);
  }
  patch(pattern: string, handler: (ctx: TContext, match: RouteMatch) => TResult | Promise<TResult>): void {
    this.add('PATCH', pattern, handler);
  }
  delete(pattern: string, handler: (ctx: TContext, match: RouteMatch) => TResult | Promise<TResult>): void {
    this.add('DELETE', pattern, handler);
  }

  match(method: string, pathname: string): { handler: (ctx: TContext, match: RouteMatch) => TResult | Promise<TResult>; match: RouteMatch } | null {
    const requestSegments = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== requestSegments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const routeSeg = route.segments[i];
        const reqSeg = requestSegments[i];
        if (routeSeg.startsWith(':')) {
          params[routeSeg.slice(1)] = decodeURIComponent(reqSeg);
        } else if (routeSeg !== reqSeg) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, match: { params } };
    }
    return null;
  }
}
