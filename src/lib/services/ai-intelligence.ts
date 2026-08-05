import { UnifiedMessageDTO } from './message-queue';
import { AIClassifierService } from './ai-classifier';
import { KnowledgeBaseService } from './knowledge-base';

/** Pure intelligence stage. Persistence and provider delivery belong to workers. */
export class AIIntelligenceService {
  static async processIncomingMessage(msg: UnifiedMessageDTO) {
    const classification = await AIClassifierService.classifyMessage(msg.content);
    const knowledge = await KnowledgeBaseService.searchRelevantKnowledge(msg.workspaceId, msg.content, classification.language);
    return { classification, knowledge };
  }
}
