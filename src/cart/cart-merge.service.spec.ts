import type { SettingsService } from '../settings/settings.service.js';
import { CartMergeService } from './cart-merge.service.js';
import type { CartRepository, CartRow } from './cart.repository.js';

describe('CartMergeService', () => {
  let mergeActiveCarts: ReturnType<typeof vi.fn>;
  let findItems: ReturnType<typeof vi.fn>;
  let getGuestMergeStrategy: ReturnType<typeof vi.fn>;
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

  beforeEach(() => {
    mergeActiveCarts = vi.fn();
    findItems = vi.fn();
    getGuestMergeStrategy = vi.fn();

    const repository = {
      mergeActiveCarts,
      findItems,
    } as unknown as CartRepository;
    const settings = {
      getGuestMergeStrategy,
    } as unknown as SettingsService;

    service = new CartMergeService(repository, settings);
  });

  it('reads the policy and merges with it', async () => {
    getGuestMergeStrategy.mockResolvedValue('guest_wins');
    mergeActiveCarts.mockResolvedValue({ cart, changed: true });

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
    // The outbox row is written inside the merge transaction, not here.
    expect(findItems).not.toHaveBeenCalled();
  });

  it('returns the cart unchanged when there was no active guest cart', async () => {
    getGuestMergeStrategy.mockResolvedValue('merge');
    mergeActiveCarts.mockResolvedValue({ cart, changed: false });

    const result = await service.merge('user-1', 'guest-session');

    expect(result.cart.id).toBe(cart.id);
    expect(findItems).not.toHaveBeenCalled();
  });
});
