import { Integrations, Conversations, ConversationMessages, Customers } from '../db/models';

import {
  INTEGRATION_KIND_CHOICES,
  CONVERSATION_STATUSES,
  FACEBOOK_DATA_KINDS,
} from '../data/constants';

import { graphRequest } from './facebookTracker';

/*
 * Get list of pages that authorized user owns
 * @param {String} accessToken - App access token
 * @return {[Object]} - page list
 */
export const getPageList = accessToken => {
  const response = graphRequest.get('/me/accounts?limit=100', accessToken);

  return response.data.map(page => ({
    id: page.id,
    name: page.name,
  }));
};

/*
 * Save webhook response
 * create conversation, customer, message using transmitted data
 *
 * @param {String} userAccessToken - User access token
 * @param {Object} integration - Integration object
 * @param {Object} data - Facebook webhook response
 */

export class SaveWebhookResponse {
  constructor(userAccessToken, integration, data) {
    this.userAccessToken = userAccessToken;

    this.integration = integration;

    // received facebook data
    this.data = data;

    this.currentPageId = null;
  }

  async start() {
    const data = this.data;
    const integration = this.integration;

    if (data.object === 'page') {
      for (let entry of data.entry) {
        // check receiving page is in integration's page list
        if (!integration.facebookData.pageIds.includes(entry.id)) {
          return null;
        }

        // set current page
        this.currentPageId = entry.id;

        // receive new messenger message
        if (entry.messaging) {
          await this.viaMessengerEvent(entry);
        }

        // receive new feed
        if (entry.changes) {
          await this.viaFeedEvent(entry);
        }
      }
    }
  }

  /*
  * Via page messenger
  */
  async viaMessengerEvent(entry) {
    for (let messagingEvent of entry.messaging) {
      // someone sent us a message
      if (messagingEvent.message) {
        await this.getOrCreateConversationByMessenger(messagingEvent);
      }
    }
  }

  /*
   * Wall post
   */
  async viaFeedEvent(entry) {
    for (let event of entry.changes) {
      // someone posted on our wall
      await this.getOrCreateConversationByFeed(event.value);
    }
  }

  /*
   * Common get or create conversation helper using both in messenger and feed
   * @param {Object} params - Parameters doc
   * @return newly create message object
   */
  async getOrCreateConversation(params) {
    // extract params
    const {
      findSelector,
      status,
      senderId,
      facebookData,
      content,
      attachments,
      msgFacebookData,
    } = params;

    let conversation = await Conversations.findOne({
      ...findSelector,
    });

    // create new conversation
    if (!conversation) {
      const conversationId = await Conversations.create({
        integrationId: this.integration._id,
        customerId: await this.getOrCreateCustomer(senderId),
        status,
        content,

        // save facebook infos
        facebookData: {
          ...facebookData,
          pageId: this.currentPageId,
        },
      });

      conversation = await Conversations.findOne({ _id: conversationId });

      // reopen conversation
    } else {
      conversation = await Conversations.reopen(conversation._id);
    }

    // create new message
    return this.createMessage({
      conversation,
      userId: senderId,
      content,
      attachments,
      facebookData: msgFacebookData,
    });
  }

  /*
   * Get or create new conversation by feed info
   * @param {Object} value - Webhook response item
   */
  async getOrCreateConversationByFeed(value) {
    const commentId = value.comment_id;

    // collect only added actions
    if (value.verb !== 'add') {
      return null;
    }

    // ignore duplicated action when like
    if (value.verb === 'add' && value.item === 'like') {
      return null;
    }

    // if this is already saved then ignore it
    if (
      commentId &&
      (await ConversationMessages.findOne({ 'facebookData.commentId': commentId }))
    ) {
      return null;
    }

    const senderName = value.sender_name;

    // sender_id is giving number values when feed and giving string value
    // when messenger. customer.facebookData.senderId has type of string so
    // convert it to string
    const senderId = value.sender_id.toString();

    let messageText = value.message;

    // when photo, video share, there will be no text, so link instead
    if (!messageText && value.link) {
      messageText = value.link;
    }

    // when situations like checkin, there will be no text and no link
    // if so ignore it
    if (!messageText) {
      return null;
    }

    // value.post_id is returning different value even though same post
    // with the previous one. So fetch post info via graph api and
    // save returned value. This value will always be the same
    let postId = value.post_id;

    // get page access token
    let response = graphRequest.get(
      `${this.currentPageId}/?fields=access_token`,
      this.userAccessToken,
    );

    // acess token expired
    if (response === 'Error processing https request') {
      return null;
    }

    // get post object
    response = graphRequest.get(postId, response.access_token);

    postId = response.id;

    let status = CONVERSATION_STATUSES.NEW;

    // if we are posting from our page, close it automatically
    if (this.integration.facebookData.pageIds.includes(senderId)) {
      status = CONVERSATION_STATUSES.CLOSED;
    }

    await this.getOrCreateConversation({
      findSelector: {
        'facebookData.kind': FACEBOOK_DATA_KINDS.FEED,
        'facebookData.postId': postId,
      },
      status,
      senderId,
      facebookData: {
        kind: FACEBOOK_DATA_KINDS.FEED,
        senderId,
        senderName,
        postId,
      },

      // message data
      content: messageText,
      msgFacebookData: {
        senderId,
        senderName,
        item: value.item,
        reactionType: value.reaction_type,
        photoId: value.photo_id,
        videoId: value.video_id,
        link: value.link,
      },
    });
  }

  /*
   * Get or create new conversation by page messenger
   * @param {Object} event - Webhook response item
   * @return Newly created message object
   */
  async getOrCreateConversationByMessenger(event) {
    const senderId = event.sender.id;
    const senderName = event.sender.name;
    const recipientId = event.recipient.id;
    const messageText = event.message.text || 'attachment';

    // collect attachment's url, type fields
    const attachments = (event.message.attachments || []).map(attachment => ({
      type: attachment.type,
      url: attachment.payload ? attachment.payload.url : '',
    }));

    await this.getOrCreateConversation({
      // try to find conversation by senderId, recipientId keys
      findSelector: {
        'facebookData.kind': FACEBOOK_DATA_KINDS.MESSENGER,
        $or: [
          {
            'facebookData.senderId': senderId,
            'facebookData.recipientId': recipientId,
          },
          {
            'facebookData.senderId': recipientId,
            'facebookData.recipientId': senderId,
          },
        ],
      },
      status: CONVERSATION_STATUSES.NEW,
      senderId,
      facebookData: {
        kind: FACEBOOK_DATA_KINDS.MESSENGER,
        senderId,
        senderName,
        recipientId,
      },

      // message data
      content: messageText,
      attachments,
      msgFacebookData: {},
    });
  }

  /*
   * Get or create customer using facebook data
   * @param {String} fbUserId - Facebook user id
   * @return Previous or newly created customer object
   */
  async getOrCreateCustomer(fbUserId) {
    const integrationId = this.integration._id;

    const customer = await Customers.findOne({
      integrationId,
      'facebookData.id': fbUserId,
    });

    if (customer) {
      return customer._id;
    }

    // get page access token
    let res = graphRequest.get(`${this.currentPageId}/?fields=access_token`, this.userAccessToken);

    // get user info
    res = graphRequest.get(`/${fbUserId}`, res.access_token);

    // when feed response will contain name field
    // when messeger response will not contain name field
    const name = res.name || `${res.first_name} ${res.last_name}`;

    // create customer
    return Customers.create({
      name,
      integrationId,
      facebookData: {
        id: fbUserId,
        profilePic: res.profile_pic,
      },
    });
  }

  /*
   * Create new message
   */
  async createMessage({ conversation, userId, content, attachments, facebookData }) {
    if (conversation) {
      // create new message
      const messageId = await ConversationMessages.create({
        conversationId: conversation._id,
        customerId: await this.getOrCreateCustomer(userId),
        content,
        attachments,
        facebookData,
        internal: false,
      });

      // TODO notify subscription server new message

      return messageId;
    }
  }
}

/*
 * Receive per app webhook response
 * @param {Object} app - Apps configuration item from .env
 * @param {Object} data - Webhook response
 */
export const receiveWebhookResponse = async (app, data) => {
  const selector = {
    kind: INTEGRATION_KIND_CHOICES.FACEBOOK,
    'facebookData.appId': app.id,
  };

  const integrations = await Integrations.find(selector);

  for (let integration of integrations) {
    // when new message or other kind of activity in page
    const saveWebhookResponse = new SaveWebhookResponse(app.accessToken, integration, data);

    await saveWebhookResponse.start();
  }
};

/*
 * Post reply to page conversation or comment to wall post
 * @param {Object} conversation - Conversation object
 * @param {Sting} text - Reply content
 * @param {String} messageId - Conversation message id
 */
export const facebookReply = async (conversation, text, messageId) => {
  const { FACEBOOK } = process.env;

  const integration = await Integrations.findOne({
    _id: conversation.integrationId,
  });

  const app = JSON.parse(FACEBOOK).find(a => a.id === integration.facebookData.appId);

  // page access token
  const response = graphRequest.get(
    `${conversation.facebookData.pageId}/?fields=access_token`,
    app.accessToken,
  );

  // messenger reply
  if (conversation.facebookData.kind === FACEBOOK_DATA_KINDS.MESSENGER) {
    return graphRequest.post(
      'me/messages',
      response.access_token,
      {
        recipient: { id: conversation.facebookData.senderId },
        message: { text },
      },
      /* istanbul ignore next */
      () => {},
    );
  }

  // feed reply
  if (conversation.facebookData.kind === FACEBOOK_DATA_KINDS.FEED) {
    const postId = conversation.facebookData.postId;

    // post reply
    const commentResponse = graphRequest.post(`${postId}/comments`, response.access_token, {
      message: text,
    });

    // save commentId in message object
    await ConversationMessages.update(
      { _id: messageId },
      { $set: { 'facebookData.commentId': commentResponse.id } },
    );
  }

  return null;
};
