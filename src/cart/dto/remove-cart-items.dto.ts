import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class RemoveCartItemsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  ids: string[];
}
