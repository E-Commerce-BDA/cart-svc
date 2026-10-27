export interface WishlistItem {
  id: string;
  productId: string;
  addedAt: string;
}

export interface WishlistResponse {
  items: WishlistItem[];
}

export interface WishlistItemResponse {
  item: WishlistItem;
}
