/**
 * The route table is a projection of the extractor's, not a second opinion.
 *
 * `hardware/hardware-map.json → network.http.routes` is where F4 recorded the
 * ten routes with `file:line` provenance. If this package's table and that file
 * ever disagree, one of them is wrong about the firmware — so the disagreement
 * has to be a test failure, not a documentation problem discovered later.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ROUTE_TABLE } from '../routes.js';

interface MapRoute {
  method: string;
  path: string;
  handlerSymbol: string;
  handlerSource: { file: string; line: number };
  registrationSource: { file: string; line: number };
  methodEnforcedInHandler?: string;
  isCatchAll?: boolean;
}

const hardwareMap = JSON.parse(
  readFileSync(new URL('../../../../hardware/hardware-map.json', import.meta.url), 'utf8'),
) as { network: { http: { routes: MapRoute[]; routeRegistrationNote: string } } };

const mapRoutes = hardwareMap.network.http.routes;

describe('ROUTE_TABLE vs hardware-map.json', () => {
  it('has the same ten routes in the same order', () => {
    expect(ROUTE_TABLE.map((r) => r.path)).toEqual(mapRoutes.map((r) => r.path));
    expect(ROUTE_TABLE).toHaveLength(10);
  });

  it('agrees on handler symbols and provenance, line for line', () => {
    for (const [index, route] of ROUTE_TABLE.entries()) {
      const expected = mapRoutes[index];
      expect(expected).toBeDefined();
      expect(route.handlerSymbol).toBe(expected?.handlerSymbol);
      expect(route.handlerSource).toEqual(expected?.handlerSource);
      expect(route.registrationSource).toEqual(expected?.registrationSource);
    }
  });

  it('records that every single route is HTTP_ANY', () => {
    // ISSUE-20260823-005 item 4 / F4 §1.9. The README's GET labels are fiction.
    for (const route of ROUTE_TABLE) expect(route.registeredMethod).toBe('ANY');
    for (const route of mapRoutes) expect(route.method).toBe('ANY');
    expect(hardwareMap.network.http.routeRegistrationNote).toContain('HTTP_ANY');
  });

  it('agrees on exactly which two handlers check the method themselves', () => {
    const ours = ROUTE_TABLE.filter((r) => r.methodEnforcedInHandler !== null).map((r) => r.path);
    const theirs = mapRoutes
      .filter((r) => r.methodEnforcedInHandler !== undefined)
      .map((r) => r.path);
    expect(ours).toEqual(['/api/command', '/api/wifi/connect']);
    expect(ours).toEqual(theirs);
  });

  it('carries the three /api/wifi/* routes the README and the report both omit', () => {
    // F4 §1.9 item 1 and §2.2 — these appear in neither document.
    const paths = ROUTE_TABLE.map((r) => r.path);
    expect(paths).toContain('/api/wifi/scan');
    expect(paths).toContain('/api/wifi/connect');
    expect(paths).toContain('/api/wifi/status');
    expect(paths).toContain('*');
  });
});
