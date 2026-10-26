export interface CartTotals {
  subtotal: number;
  itemCount: number;
  lineCount: number;
}

export interface CartDto {
  id: string;
  userId: string | null;
  sessionId: string | null;
  status: string;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CartItemDto {
  id: string;
  productId: string;
  variantId: string | null;
  qty: number;
  unitPrice: number;
  productName: string;
  productSlug: string | null;
  imageUrl: string | null;
  variantLabel: string | null;
  addedAt: string;
}

export interface CartResponse {
  cart: CartDto;
  items: CartItemDto[];
  totals: CartTotals;
}

export interface CartMutationResponse {
  item: CartItemDto;
  cartTotals: CartTotals;
}
