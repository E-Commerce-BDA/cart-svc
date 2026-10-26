import { Injectable } from '@nestjs/common';

export const CATALOG_CLIENT = Symbol('CATALOG_CLIENT');

export interface CatalogProductSnapshot {
  productId: string;
  variantId: string | null;
  productName: string;
  productSlug: string;
  imageUrl: string | null;
  variantLabel: string | null;
  unitPrice: number;
  available: boolean;
}

export interface CatalogClient {
  getProduct(
    productId: string,
    variantId: string | null,
  ): Promise<CatalogProductSnapshot | null>;
}

/**
 * Local catalog adapter. The cart stores these fields as snapshots, so tests
 * never need catalog-svc or a catalog schema.
 */
@Injectable()
export class FixtureCatalogClient implements CatalogClient {
  async getProduct(
    productId: string,
    variantId: string | null,
  ): Promise<CatalogProductSnapshot | null> {
    return (
      FIXTURE_PRODUCTS.find(
        (product) =>
          product.productId === productId &&
          product.variantId === variantId &&
          product.available,
      ) ?? null
    );
  }
}

export const FIXTURE_PRODUCTS: readonly CatalogProductSnapshot[] = [
  {
    productId: '0190a8b0-0000-7000-8000-000000000101',
    variantId: '0190a8b0-0000-7000-8000-000000000201',
    productName: 'Fixture Tee',
    productSlug: 'fixture-tee',
    imageUrl: '/images/fixture-tee.jpg',
    variantLabel: 'Black / M',
    unitPrice: 79.99,
    available: true,
  },
  {
    productId: '0190a8b0-0000-7000-8000-000000000102',
    variantId: null,
    productName: 'Fixture Mug',
    productSlug: 'fixture-mug',
    imageUrl: '/images/fixture-mug.jpg',
    variantLabel: null,
    unitPrice: 12.5,
    available: true,
  },
  {
    productId: '0190a8b0-0000-7000-8000-000000000103',
    variantId: null,
    productName: 'Discontinued Lamp',
    productSlug: 'discontinued-lamp',
    imageUrl: null,
    variantLabel: null,
    unitPrice: 45,
    available: false,
  },
];
