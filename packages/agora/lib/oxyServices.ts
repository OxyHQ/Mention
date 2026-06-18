import { OxyServices } from '@oxyhq/core';
import { OXY_BASE_URL } from '@/config';

export const oxyServices = new OxyServices({ baseURL: OXY_BASE_URL });
