import { describe, expect, it } from 'vitest';
import { registrableDomain } from '../src/sources/normalize.js';

describe('registrableDomain', () => {
  it.each([
    ['www.Example.com', 'example.com'],
    ['shop.brand.co.uk.', 'brand.co.uk'],
    ['*.studio.com.au', 'studio.com.au'],
    ['a.b.c.example.io', 'example.io'],
  ])('%s -> %s', (host, domain) => expect(registrableDomain(host)).toEqual({ domain }));

  it.each([
    ['store.myshopify.com', 'private_suffix'],
    ['site.github.io', 'private_suffix'],
    ['1.2.3.4', 'ip'],
    ['localhost', 'invalid'],
    ['bad host.com', 'invalid'],
    ['co.uk', 'no_registrable'],
  ])('%s dropped as %s', (host, drop) => expect(registrableDomain(host)).toEqual({ drop }));
});
