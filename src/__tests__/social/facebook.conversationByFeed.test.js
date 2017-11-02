/* eslint-env jest */

import sinon from 'sinon';
import { connect, disconnect } from '../../db/connection';
import { SaveWebhookResponse } from '../../social/facebook';
import { graphRequest } from '../../social/facebookTracker';
import { Conversations, ConversationMessages } from '../../db/models';
import { integrationFactory, conversationMessageFactory } from '../../db/factories';
import { CONVERSATION_STATUSES } from '../../data/constants';

beforeAll(() => connect());
afterAll(() => disconnect());

describe('facebook integration: get or create conversation by feed info', () => {
  afterEach(async () => {
    // clear
    await Conversations.remove({});
    await ConversationMessages.remove({});

    graphRequest.get.restore(); // unwraps the spy
  });

  it('admin posts', async () => {
    const senderId = 'DFDFDEREREEFFFD';
    const postId = 'DFJDFJDIF';

    // indicating sender is our admins, in other words posting from our page
    const pageId = senderId;

    const integration = await integrationFactory({
      facebookData: {
        appId: '242424242422',
        pageIds: [pageId, 'DFDFDFDFDFD'],
      },
    });

    const saveWebhookResponse = new SaveWebhookResponse('access_token', integration);

    saveWebhookResponse.currentPageId = 'DFDFDFDFDFD';

    // must be 0 conversations
    expect(await Conversations.find().count()).toBe(0);

    const value = { sender_id: senderId };

    // check invalid verb
    value.verb = 'edit';
    expect(await saveWebhookResponse.getOrCreateConversationByFeed(value)).toBe(null);

    // ignore likes
    value.verb = 'add';
    value.item = 'like';
    expect(await saveWebhookResponse.getOrCreateConversationByFeed(value)).toBe(null);

    // already saved comments ==========
    await conversationMessageFactory({ facebookData: { commentId: 1 } });

    value.item = null;
    value.comment_id = 1;

    expect(await saveWebhookResponse.getOrCreateConversationByFeed(value)).toBe(null);

    // no message
    await ConversationMessages.remove({});
    value.message = '';
    expect(await saveWebhookResponse.getOrCreateConversationByFeed(value)).toBe(null);

    // access token expired
    value.link = 'link';
    sinon.stub(graphRequest, 'get').callsFake(() => 'Error processing https request');
    expect(await saveWebhookResponse.getOrCreateConversationByFeed(value)).toBe(null);
    graphRequest.get.restore();

    // successful ==============
    // mock external requests
    sinon.stub(graphRequest, 'get').callsFake(path => {
      if (path.includes('/?fields=access_token')) {
        return {
          access_token: '244242442442',
        };
      }

      return {};
    });

    value.post_id = postId;
    value.message = 'hi';

    await saveWebhookResponse.getOrCreateConversationByFeed(value);

    expect(await Conversations.find().count()).toBe(1); // 1 conversation

    const conversation = await Conversations.findOne();

    // our posts will be closed automatically
    expect(conversation.status).toBe(CONVERSATION_STATUSES.CLOSED);
  });
});
