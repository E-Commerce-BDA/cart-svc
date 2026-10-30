import type { CartIdentity } from '../auth/guards/cart-identity.guard.js';
import type { EventBus } from '../events/event-bus.js';
import type { CatalogClient } from './catalog.client.js';
import { FIXTURE_PRODUCTS } from './catalog.client.js';
import type { CartRepository, CartItemRow, CartRow } from './cart.repository.js';
import { computeTotals } from './cart.mapper.js';
import { CartService } from './cart.service.js';

const TEE = FIXTURE_PRODUCTS[0];
const MUG = FIXTURE_PRODUCTS[1];

describe('CartService', () => {
  let ensureActiveCart: ReturnType<typeof vi.fn>;
  let findActiveCart: ReturnType<typeof vi.fn>;
  let findItems: ReturnType<typeof vi.fn>;
  let addItem: ReturnType<typeof vi.fn>;
  let updateItemQty: ReturnType<typeof vi.fn>;
  let deleteItem: ReturnType<typeof vi.fn>;
  let deleteItems: ReturnType<typeof vi.fn>;
  let clearItems: ReturnType<typeof vi.fn>;
  let convertActiveCart: ReturnType<typeof vi.fn>;
  let catalogGetProduct: ReturnType<typeof vi.fn>;
  let publish: ReturnType<typeof vi.fn>;
  let service: CartService;

  const identity: CartIdentity = {
    type: 'session',
    sessionId: 'guest-session',
  };
  const cart: CartRow = {
    id: 'cart-1',
    user_id: null,
    session_id: 'guest-session',
    status: 'active',
    last_activity_at: new Date('2026-10-27T00:00:00Z'),
    created_at: new Date('2026-10-27T00:00:00Z'),
    updated_at: new Date('2026-10-27T00:00:00Z'),
  };

  beforeEach(() => {
    ensureActiveCart = vi.fn();
    findActiveCart = vi.fn();
    findItems = vi.fn();
    addItem = vi.fn();
    updateItemQty = vi.fn();
    deleteItem = vi.fn();
    deleteItems = vi.fn();
    clearItems = vi.fn();
    convertActiveCart = vi.fn();
    catalogGetProduct = vi.fn();
    publish = vi.fn();

    const repository = {
      ensureActiveCart,
      findActiveCart,
      findItems,
      addItem,
      updateItemQty,
      deleteItem,
      deleteItems,
      clearItems,
      convertActiveCart,
    } as unknown as CartRepository;
    const catalog = {
      getProduct: catalogGetProduct,
    } as unknown as CatalogClient;
    const eventBus = { publish } as unknown as EventBus;

    service = new CartService(repository, catalog, eventBus);
  });

  it('returns items and cent-accurate totals without emitting an event', async () => {
    ensureActiveCart.mockResolvedValue(cart);
    findItems.mockResolvedValue([item({ qty: 2 })]);

    const result = await service.getCart(identity);

    expect(result.cart.id).toBe(cart.id);
    expect(result.items[0]).toMatchObject({
      productId: TEE.productId,
      unitPrice: 79.99,
    });
    expect(result.totals).toEqual({
      subtotal: 159.98,
      itemCount: 2,
      lineCount: 1,
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects an unavailable catalog product before touching the cart', async () => {
    catalogGetProduct.mockResolvedValue(null);

    await expect(
      service.addItem(identity, { productId: TEE.productId, qty: 1 }),
    ).rejects.toMatchObject({
      response: { code: 'CART_PRODUCT_UNAVAILABLE' },
    });
    expect(ensureActiveCart).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('snapshots the catalog product and emits one event on add', async () => {
    catalogGetProduct.mockResolvedValue(TEE);
    ensureActiveCart.mockResolvedValue(cart);
    addItem.mockResolvedValue({ item: item({ qty: 2 }), cart });
    findItems.mockResolvedValue([item({ qty: 2 })]);

    const result = await service.addItem(identity, {
      productId: TEE.productId,
      variantId: TEE.variantId,
      qty: 2,
    });

    expect(catalogGetProduct).toHaveBeenCalledWith(
      TEE.productId,
      TEE.variantId,
    );
    expect(result.item).toMatchObject({
      productName: TEE.productName,
      productSlug: TEE.productSlug,
      imageUrl: TEE.imageUrl,
      variantLabel: TEE.variantLabel,
      unitPrice: 79.99,
    });
    expect(result.cartTotals).toEqual({
      subtotal: 159.98,
      itemCount: 2,
      lineCount: 1,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        cartId: cart.id,
        sessionId: 'guest-session',
        userId: null,
        totals: { subtotal: 159.98, itemCount: 2, lineCount: 1 },
      }),
    );
  });

  it('returns 404 and emits nothing for a foreign item update', async () => {
    findActiveCart.mockResolvedValue(cart);
    updateItemQty.mockResolvedValue(null);

    await expect(
      service.updateItem(identity, 'foreign-item', 2),
    ).rejects.toMatchObject({
      response: { code: 'CART_ITEM_NOT_FOUND' },
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns 404 and emits nothing when a batch has no owned ids', async () => {
    findActiveCart.mockResolvedValue(cart);
    deleteItems.mockResolvedValue({ deletedCount: 0, cart: null });

    await expect(
      service.removeItems(identity, ['foreign-item']),
    ).rejects.toMatchObject({
      response: { code: 'CART_ITEM_NOT_FOUND' },
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('treats clearing a missing cart as a no-op', async () => {
    findActiveCart.mockResolvedValue(null);

    await service.clearCart(identity);

    expect(clearItems).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('clears an existing cart and emits one empty-cart event', async () => {
    findActiveCart.mockResolvedValue(cart);
    clearItems.mockResolvedValue({ deletedCount: 2, cart });
    findItems.mockResolvedValue([]);

    await service.clearCart(identity);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      cartId: cart.id,
      totals: { subtotal: 0, itemCount: 0, lineCount: 0 },
    });
  });

  it('removes one item and emits once', async () => {
    findActiveCart.mockResolvedValue(cart);
    deleteItem.mockResolvedValue(cart);
    findItems.mockResolvedValue([]);

    await service.removeItem(identity, 'item-1');

    expect(publish).toHaveBeenCalledTimes(1);
  });

  describe('convertCart', () => {
    const userCart: CartRow = {
      ...cart,
      user_id: '11111111-1111-4111-8111-111111111111',
      session_id: null,
      status: 'converted',
      last_activity_at: new Date('2026-10-30T10:00:00Z'),
    };

    it('returns the converted cart and publishes one cart.updated', async () => {
      convertActiveCart.mockResolvedValue(userCart);
      findItems.mockResolvedValue([item({ qty: 2 })]);

      const result = await service.convertCart(userCart.user_id!);

      expect(convertActiveCart).toHaveBeenCalledWith(userCart.user_id);
      expect(result).toEqual({
        cartId: userCart.id,
        convertedAt: '2026-10-30T10:00:00.000Z',
      });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0][0]).toMatchObject({
        cartId: userCart.id,
        status: 'converted',
        totals: { subtotal: 159.98, itemCount: 2, lineCount: 1 },
      });
    });

    it('returns null and stays silent when there is no active cart', async () => {
      convertActiveCart.mockResolvedValue(null);

      await expect(service.convertCart(userCart.user_id!)).resolves.toBeNull();

      expect(findItems).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    });
  });

  it('sums quantities and money in cents across lines', () => {
    const tee = item({ qty: 3 });
    const mug = item({
      id: 'item-mug',
      product_id: MUG.productId,
      variant_id: null,
      qty: 2,
      unit_price: '12.50',
      product_name: MUG.productName,
      product_slug: MUG.productSlug,
      image_url: MUG.imageUrl,
      variant_label: MUG.variantLabel,
    });

    expect(computeTotals([tee, mug])).toEqual({
      subtotal: 264.97,
      itemCount: 5,
      lineCount: 2,
    });
  });

  function item(overrides: Partial<CartItemRow> = {}): CartItemRow {
    return {
      id: 'item-1',
      cart_id: cart.id,
      product_id: TEE.productId,
      variant_id: TEE.variantId,
      qty: 2,
      unit_price: '79.99',
      product_name: TEE.productName,
      product_slug: TEE.productSlug,
      image_url: TEE.imageUrl,
      variant_label: TEE.variantLabel,
      added_at: new Date('2026-10-27T00:00:00Z'),
      ...overrides,
    };
  }
});
