import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class AddCartItemDto {
  @IsUUID('all')
  productId: string;

  @IsOptional()
  @IsUUID('all')
  variantId?: string | null;

  @IsInt()
  @Min(1)
  qty: number;
}
