import { IsUUID } from 'class-validator';

export class AddWishlistItemDto {
  @IsUUID('all', { message: 'productId must be a valid UUID' })
  productId: string;
}
