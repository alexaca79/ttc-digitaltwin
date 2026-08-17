import { date, entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class OperatorNote {
  @uuid() id!: string;
  @text({ min: 1, max: 80 }) title!: string;
  @text({ min: 1, max: 1200 }) body!: string;
  @text({ min: 1, max: 16 }) severity!: string;
  @text({ max: 32, optional: true }) routeId?: string;
  @text({ max: 64, optional: true }) vehicleId?: string;
  @date() createdAt!: Date;
  @date() updatedAt!: Date;
  @text({ max: 128 }) user_id!: string;
}