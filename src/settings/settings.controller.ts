import {
  Body,
  Controller,
  Get,
  Header,
  Patch,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { getRequestId } from '../common/http/request-id.js';
import { UpdateSettingsDto } from './dto/update-settings.dto.js';
import {
  SettingsDocument,
  SettingsResponse,
  SettingsService,
} from './settings.service.js';

@Controller('cart/settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  getSettings(): Promise<SettingsResponse> {
    return this.settingsService.getSettings();
  }

  @Patch()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  updateSettings(
    @Body() dto: UpdateSettingsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<SettingsDocument> {
    const actorId = request.user?.sub;

    if (!actorId) {
      throw new UnauthorizedException('Authentication is required');
    }

    return this.settingsService.updateSettings({
      version: dto.version,
      values: dto.values,
      reset: dto.reset,
      actorId,
      requestId: getRequestId(request).slice(0, 64),
    });
  }
}
