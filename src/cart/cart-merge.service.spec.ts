import type { EventBus } from '../events/event-bus.js';
import type { SettingsService } from '../settings/settings.service.js';
import { CartMergeService } from './cart-merge.service.js';
import type { CartRepository, CartItemRow, CartRow } from './cart.repository.js';

describe('CartMergeService', () => {
  let mergeActiveCarts: ReturnType<typeof vi.fn>;
  let findItems: ReturnType<typeof vi.fn>;
  let getGuestMergeStrategy: ReturnType<typeof vi.fn>;
  let publish: ReturnType<typeof vi.fn>;
  let service: CartMergeService;

  const cart: CartRow = {
    id: 'cart-1',
    user_id: 'user-1',
    session_id: null,
    status: 'active',
    last_activity_at: new Date('2026-10-27T00:00:00Z'),
    created_at: new Date('2026-10-27T00:00:00Z'),
    updated_at: new Date('2026-10-27T00:00:00Z'),
  };
  const item: CartItemRow = {
    id: 'item-1',
    cart_id: cart.id,
    product_id: '0190a8b0-0000-7000-8000-000000000101',
    variant_id: null,
    qty: 3,
    unit_price: '79.99',
    product_name: 'Fixture Tee',
    product_slug: 'fixture-tee',
    image_url: '/images/fixture-tee.jpg',
    variant_label: null,
    added_at: new Date('2026-10-27T00:00:00Z'),
  };

  beforeEach(() => {
    mergeActiveCarts = vi.fn();
    findItems = vi.fn();
    getGuestMergeStrategy = vi.fn();
    publish = vi.fn();

    const repository = {
      mergeActiveCarts,
      findItems,
    } as unknown as CartRepository;
    const settings = {
      getGuestMergeStrategy,
    } as unknown as SettingsService;
    const eventBus = { publish } as unknown as EventBus;

    service = new CartMergeService(repository, settings, eventBus);
  });

  it('reads the policy, merges, and emits one event', async () => {
    getGuestMergeStrategy.mockResolvedValue('guest_wins');
    mergeActiveCarts.mockResolvedValue({ cart, changed: true });
    findItems.mockResolvedValue([item]);

    const result = await service.merge('user-1', 'guest-session');

    expect(getGuestMergeStrategy).toHaveBeenCalledTimes(1);
    expect(mergeActiveCarts).toHaveBeenCalledWith(
      'user-1',
      'guest-session',
      'guest_wins',
    );
    expect(result.cart).toMatchObject({
      id: cart.id,
      userId: 'user-1',
      sessionId: null,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        cartId: cart.id,
        userId: 'user-1',
        totals: { subtotal: 239.97, itemCount: 3, lineCount: 1 },
      }),
    );
  });

  it('does not emit when there was no active guest cart', async () => {
    getGuestMergeStrategy.mockResolvedValue('merge');
    mergeActiveCarts.mockResolvedValue({ cart, changed: false });

    const result = await service.merge('user-1', 'guest-session');

    expect(result.cart.id).toBe(cart.id);
    expect(findItems).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps the merge successful when the event bus throws', async () => {
    getGuestMergeStrategy.mockResolvedValue('merge');
    mergeActiveCarts.mockResolvedValue({ cart, changed: true });
    findItems.mockResolvedValue([item]);
    publish.mockImplementation(() => {
      throw new Error('broker down');
    });

    await expect(
      service.merge('user-1', 'guest-session'),
    ).resolves.toMatchObject({ cart: { id: cart.id } });
  });
});
