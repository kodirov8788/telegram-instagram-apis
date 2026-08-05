import pool from '../../db';
import { DatabaseSecretProvider } from '../../services/secret-provider';
import { processInboundEvent as processInbound } from './inbound';
import { processOutboundJob as processOutbound } from './outbound';

export const processInboundEvent = processInbound;

export const processOutboundJob = (id: string) =>
  processOutbound(id, new DatabaseSecretProvider(pool));
