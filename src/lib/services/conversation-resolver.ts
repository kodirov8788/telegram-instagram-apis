import type { DbClient } from '../db';
import type { UnifiedMessageDTO } from './message-queue';
export interface ActiveConversation { id:string; workspace_id:string; connection_id:string; customer_id:string; channel:UnifiedMessageDTO['channel']; status:string; }
export class ConversationResolverService {
 static async resolve(connectionId:string,customerId:string,client:DbClient):Promise<ActiveConversation> {
  if(!connectionId||!customerId) throw new Error('connectionId and customerId are required');
  const result=await client.query('SELECT * FROM resolve_active_conversation($1,$2)',[connectionId,customerId]);
  const conversation=result.rows[0] as ActiveConversation|undefined;
  if(!conversation) throw new Error('conversation resolver returned no conversation');
  return conversation;
 }
}
