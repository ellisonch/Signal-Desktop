// Copyright 2020-2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { debounce, uniq, without } from 'lodash';
import PQueue from 'p-queue';

import dataInterface from './sql/Client';
import type {
  ConversationModelCollectionType,
  ConversationAttributesType,
  ConversationAttributesTypeType,
} from './model-types.d';
import type { ConversationModel } from './models/conversations';
import { getContactId } from './messages/helpers';
import { maybeDeriveGroupV2Id } from './groups';
import { assert } from './util/assert';
import { isGroupV1, isGroupV2 } from './util/whatTypeOfConversation';
import { getConversationUnreadCountForAppBadge } from './util/getConversationUnreadCountForAppBadge';
import { UUID, isValidUuid } from './types/UUID';
import { Address } from './types/Address';
import { QualifiedAddress } from './types/QualifiedAddress';
import * as log from './logging/log';
import { sleep } from './util/sleep';
import { isNotNil } from './util/isNotNil';
import { MINUTE, SECOND } from './util/durations';

const MAX_MESSAGE_BODY_LENGTH = 64 * 1024;

const {
  getAllConversations,
  getAllGroupsInvolvingUuid,
  getMessagesBySentAt,
  migrateConversationMessages,
  removeConversation,
  saveConversation,
  updateConversation,
} = dataInterface;

// We have to run this in background.js, after all backbone models and collections on
//   Whisper.* have been created. Once those are in typescript we can use more reasonable
//   require statements for referencing these things, giving us more flexibility here.
export function start(): void {
  const conversations = new window.Whisper.ConversationCollection();

  window.getConversations = () => conversations;
  window.ConversationController = new ConversationController(conversations);
}

export class ConversationController {
  private _initialFetchComplete = false;

  private _initialPromise: undefined | Promise<void>;

  private _conversationOpenStart = new Map<string, number>();

  private _hasQueueEmptied = false;

  constructor(private _conversations: ConversationModelCollectionType) {
    const debouncedUpdateUnreadCount = debounce(
      this.updateUnreadCount.bind(this),
      SECOND,
      {
        leading: true,
        maxWait: SECOND,
        trailing: true,
      }
    );

    // A few things can cause us to update the app-level unread count
    window.Whisper.events.on('updateUnreadCount', debouncedUpdateUnreadCount);
    this._conversations.on(
      'add remove change:active_at change:unreadCount change:markedUnread change:isArchived change:muteExpiresAt',
      debouncedUpdateUnreadCount
    );

    // If the conversation is muted we set a timeout so when the mute expires
    // we can reset the mute state on the model. If the mute has already expired
    // then we reset the state right away.
    this._conversations.on('add', (model: ConversationModel): void => {
      model.startMuteTimer();
    });
  }

  updateUnreadCount(): void {
    if (!this._hasQueueEmptied) {
      return;
    }

    const canCountMutedConversations =
      window.storage.get('badge-count-muted-conversations') || false;

    const newUnreadCount = this._conversations.reduce(
      (result: number, conversation: ConversationModel) =>
        result +
        getConversationUnreadCountForAppBadge(
          conversation.attributes,
          canCountMutedConversations
        ),
      0
    );
    window.storage.put('unreadCount', newUnreadCount);

    if (newUnreadCount > 0) {
      window.setBadgeCount(newUnreadCount);
      window.document.title = `${window.getTitle()} (${newUnreadCount})`;
    } else {
      window.setBadgeCount(0);
      window.document.title = window.getTitle();
    }
    window.updateTrayIcon(newUnreadCount);
  }

  onEmpty(): void {
    this._hasQueueEmptied = true;
    this.updateUnreadCount();
  }

  get(id?: string | null): ConversationModel | undefined {
    if (!this._initialFetchComplete) {
      throw new Error(
        'ConversationController.get() needs complete initial fetch'
      );
    }

    // This function takes null just fine. Backbone typings are too restrictive.
    return this._conversations.get(id as string);
  }

  getAll(): Array<ConversationModel> {
    return this._conversations.models;
  }

  dangerouslyCreateAndAdd(
    attributes: Partial<ConversationAttributesType>
  ): ConversationModel {
    return this._conversations.add(attributes);
  }

  dangerouslyRemoveById(id: string): void {
    this._conversations.remove(id);
    this._conversations.resetLookups();
  }

  getOrCreate(
    identifier: string | null,
    type: ConversationAttributesTypeType,
    additionalInitialProps = {}
  ): ConversationModel {
    if (typeof identifier !== 'string') {
      throw new TypeError("'id' must be a string");
    }

    if (type !== 'private' && type !== 'group') {
      throw new TypeError(
        `'type' must be 'private' or 'group'; got: '${type}'`
      );
    }

    if (!this._initialFetchComplete) {
      throw new Error(
        'ConversationController.get() needs complete initial fetch'
      );
    }

    let conversation = this._conversations.get(identifier);
    if (conversation) {
      return conversation;
    }

    const id = UUID.generate().toString();

    if (type === 'group') {
      conversation = this._conversations.add({
        id,
        uuid: null,
        e164: null,
        groupId: identifier,
        type,
        version: 2,
        ...additionalInitialProps,
      });
    } else if (isValidUuid(identifier)) {
      conversation = this._conversations.add({
        id,
        uuid: identifier,
        e164: null,
        groupId: null,
        type,
        version: 2,
        ...additionalInitialProps,
      });
    } else {
      conversation = this._conversations.add({
        id,
        uuid: null,
        e164: identifier,
        groupId: null,
        type,
        version: 2,
        ...additionalInitialProps,
      });
    }

    const create = async () => {
      if (!conversation.isValid()) {
        const validationError = conversation.validationError || {};
        log.error(
          'Contact is not valid. Not saving, but adding to collection:',
          conversation.idForLogging(),
          validationError.stack
        );

        return conversation;
      }

      try {
        if (isGroupV1(conversation.attributes)) {
          maybeDeriveGroupV2Id(conversation);
        }
        await saveConversation(conversation.attributes);
      } catch (error) {
        log.error(
          'Conversation save failed! ',
          identifier,
          type,
          'Error:',
          error && error.stack ? error.stack : error
        );
        throw error;
      }

      return conversation;
    };

    conversation.initialPromise = create();

    return conversation;
  }

  async getOrCreateAndWait(
    id: string | null,
    type: ConversationAttributesTypeType,
    additionalInitialProps = {}
  ): Promise<ConversationModel> {
    await this.load();
    const conversation = this.getOrCreate(id, type, additionalInitialProps);

    if (conversation) {
      await conversation.initialPromise;
      return conversation;
    }

    throw new Error('getOrCreateAndWait: did not get conversation');
  }

  getConversationId(address: string | null): string | null {
    if (!address) {
      return null;
    }

    const [id] = window.textsecure.utils.unencodeNumber(address);
    const conv = this.get(id);

    if (conv) {
      return conv.get('id');
    }

    return null;
  }

  getOurConversationId(): string | undefined {
    const e164 = window.textsecure.storage.user.getNumber();
    const uuid = window.textsecure.storage.user.getUuid()?.toString();
    return this.ensureContactIds({
      e164,
      uuid,
      highTrust: true,
      reason: 'getOurConversationId',
    });
  }

  getOurConversationIdOrThrow(): string {
    const conversationId = this.getOurConversationId();
    if (!conversationId) {
      throw new Error(
        'getOurConversationIdOrThrow: Failed to fetch ourConversationId'
      );
    }
    return conversationId;
  }

  getOurConversation(): ConversationModel | undefined {
    const conversationId = this.getOurConversationId();
    return conversationId ? this.get(conversationId) : undefined;
  }

  getOurConversationOrThrow(): ConversationModel {
    const conversation = this.getOurConversation();
    if (!conversation) {
      throw new Error(
        'getOurConversationOrThrow: Failed to fetch our own conversation'
      );
    }

    return conversation;
  }

  areWePrimaryDevice(): boolean {
    const ourDeviceId = window.textsecure.storage.user.getDeviceId();

    return ourDeviceId === 1;
  }

  /**
   * Given a UUID and/or an E164, resolves to a string representing the local
   * database id of the given contact. In high trust mode, it may create new contacts,
   * and it may merge contacts.
   *
   * highTrust = uuid/e164 pairing came from CDS, the server, or your own device
   */
  ensureContactIds({
    e164,
    uuid,
    highTrust,
    reason,
  }:
    | {
        e164?: string | null;
        uuid?: string | null;
        highTrust?: false;
        reason?: void;
      }
    | {
        e164?: string | null;
        uuid?: string | null;
        highTrust: true;
        reason: string;
      }): string | undefined {
    // Check for at least one parameter being provided. This is necessary
    // because this path can be called on startup to resolve our own ID before
    // our phone number or UUID are known. The existing behavior in these
    // cases can handle a returned `undefined` id, so we do that.
    const normalizedUuid = uuid ? uuid.toLowerCase() : undefined;
    const identifier = normalizedUuid || e164;

    if ((!e164 && !uuid) || !identifier) {
      return undefined;
    }

    const convoE164 = this.get(e164);
    const convoUuid = this.get(normalizedUuid);

    // 1. Handle no match at all
    if (!convoE164 && !convoUuid) {
      log.info(
        'ensureContactIds: Creating new contact, no matches found',
        highTrust ? reason : 'no reason'
      );
      const newConvo = this.getOrCreate(identifier, 'private');
      if (highTrust && e164) {
        newConvo.updateE164(e164);
      }
      if (normalizedUuid) {
        newConvo.updateUuid(normalizedUuid);
      }
      if ((highTrust && e164) || normalizedUuid) {
        updateConversation(newConvo.attributes);
      }

      return newConvo.get('id');

      // 2. Handle match on only E164
    }
    if (convoE164 && !convoUuid) {
      const haveUuid = Boolean(normalizedUuid);
      log.info(
        `ensureContactIds: e164-only match found (have UUID: ${haveUuid})`
      );
      // If we are only searching based on e164 anyway, then return the first result
      if (!normalizedUuid) {
        return convoE164.get('id');
      }

      // Fill in the UUID for an e164-only contact
      if (normalizedUuid && !convoE164.get('uuid')) {
        if (highTrust) {
          log.info(
            `ensureContactIds: Adding UUID (${uuid}) to e164-only match ` +
              `(${e164}), reason: ${reason}`
          );
          convoE164.updateUuid(normalizedUuid);
          updateConversation(convoE164.attributes);
        }
        return convoE164.get('id');
      }

      log.info(
        'ensureContactIds: e164 already had UUID, creating a new contact'
      );
      // If existing e164 match already has UUID, create a new contact...
      const newConvo = this.getOrCreate(normalizedUuid, 'private');

      if (highTrust) {
        log.info(
          `ensureContactIds: Moving e164 (${e164}) from old contact ` +
            `(${convoE164.get('uuid')}) to new (${uuid}), reason: ${reason}`
        );

        // Remove the e164 from the old contact...
        convoE164.set({ e164: undefined });
        updateConversation(convoE164.attributes);

        // ...and add it to the new one.
        newConvo.updateE164(e164);
        updateConversation(newConvo.attributes);
      }

      return newConvo.get('id');

      // 3. Handle match on only UUID
    }
    if (!convoE164 && convoUuid) {
      if (e164 && highTrust) {
        log.info(
          `ensureContactIds: Adding e164 (${e164}) to UUID-only match ` +
            `(${uuid}), reason: ${reason}`
        );
        convoUuid.updateE164(e164);
        updateConversation(convoUuid.attributes);
      }
      return convoUuid.get('id');
    }

    // For some reason, TypeScript doesn't believe that we can trust that these two values
    //   are truthy by this point. So we'll throw if we get there.
    if (!convoE164 || !convoUuid) {
      throw new Error('ensureContactIds: convoE164 or convoUuid are falsey!');
    }

    // Now, we know that we have a match for both e164 and uuid checks

    if (convoE164 === convoUuid) {
      return convoUuid.get('id');
    }

    if (highTrust) {
      // Conflict: If e164 match already has a UUID, we remove its e164.
      if (convoE164.get('uuid') && convoE164.get('uuid') !== normalizedUuid) {
        log.info(
          `ensureContactIds: e164 match (${e164}) had different ` +
            `UUID(${convoE164.get('uuid')}) than incoming pair (${uuid}), ` +
            `removing its e164, reason: ${reason}`
        );

        // Remove the e164 from the old contact...
        convoE164.set({ e164: undefined });
        updateConversation(convoE164.attributes);

        // ...and add it to the new one.
        convoUuid.updateE164(e164);
        updateConversation(convoUuid.attributes);

        return convoUuid.get('id');
      }

      log.warn(
        `ensureContactIds: Found a split contact - UUID ${normalizedUuid} and E164 ${e164}. Merging.`
      );

      // Conflict: If e164 match has no UUID, we merge. We prefer the UUID match.
      // Note: no await here, we want to keep this function synchronous
      convoUuid.updateE164(e164);
      // `then` is used to trigger async updates, not affecting return value
      // eslint-disable-next-line more/no-then
      this.combineConversations(convoUuid, convoE164)
        .then(() => {
          // If the old conversation was currently displayed, we load the new one
          window.Whisper.events.trigger('refreshConversation', {
            newId: convoUuid.get('id'),
            oldId: convoE164.get('id'),
          });
        })
        .catch(error => {
          const errorText = error && error.stack ? error.stack : error;
          log.warn(`ensureContactIds error combining contacts: ${errorText}`);
        });
    }

    return convoUuid.get('id');
  }

  async checkForConflicts(): Promise<void> {
    log.info('checkForConflicts: starting...');
    const byUuid = Object.create(null);
    const byE164 = Object.create(null);
    const byGroupV2Id = Object.create(null);
    // We also want to find duplicate GV1 IDs. You might expect to see a "byGroupV1Id" map
    //   here. Instead, we check for duplicates on the derived GV2 ID.

    const { models } = this._conversations;

    // We iterate from the oldest conversations to the newest. This allows us, in a
    //   conflict case, to keep the one with activity the most recently.
    for (let i = models.length - 1; i >= 0; i -= 1) {
      const conversation = models[i];
      assert(
        conversation,
        'Expected conversation to be found in array during iteration'
      );

      const uuid = conversation.get('uuid');
      const e164 = conversation.get('e164');

      if (uuid) {
        const existing = byUuid[uuid];
        if (!existing) {
          byUuid[uuid] = conversation;
        } else {
          log.warn(`checkForConflicts: Found conflict with uuid ${uuid}`);

          // Keep the newer one if it has an e164, otherwise keep existing
          if (conversation.get('e164')) {
            // Keep new one
            // eslint-disable-next-line no-await-in-loop
            await this.combineConversations(conversation, existing);
            byUuid[uuid] = conversation;
          } else {
            // Keep existing - note that this applies if neither had an e164
            // eslint-disable-next-line no-await-in-loop
            await this.combineConversations(existing, conversation);
          }
        }
      }

      if (e164) {
        const existing = byE164[e164];
        if (!existing) {
          byE164[e164] = conversation;
        } else {
          // If we have two contacts with the same e164 but different truthy UUIDs, then
          //   we'll delete the e164 on the older one
          if (
            conversation.get('uuid') &&
            existing.get('uuid') &&
            conversation.get('uuid') !== existing.get('uuid')
          ) {
            log.warn(
              `checkForConflicts: Found two matches on e164 ${e164} with different truthy UUIDs. Dropping e164 on older.`
            );

            existing.set({ e164: undefined });
            updateConversation(existing.attributes);

            byE164[e164] = conversation;

            continue;
          }

          log.warn(`checkForConflicts: Found conflict with e164 ${e164}`);

          // Keep the newer one if it has a UUID, otherwise keep existing
          if (conversation.get('uuid')) {
            // Keep new one
            // eslint-disable-next-line no-await-in-loop
            await this.combineConversations(conversation, existing);
            byE164[e164] = conversation;
          } else {
            // Keep existing - note that this applies if neither had a UUID
            // eslint-disable-next-line no-await-in-loop
            await this.combineConversations(existing, conversation);
          }
        }
      }

      let groupV2Id: undefined | string;
      if (isGroupV1(conversation.attributes)) {
        maybeDeriveGroupV2Id(conversation);
        groupV2Id = conversation.get('derivedGroupV2Id');
        assert(
          groupV2Id,
          'checkForConflicts: expected the group V2 ID to have been derived, but it was falsy'
        );
      } else if (isGroupV2(conversation.attributes)) {
        groupV2Id = conversation.get('groupId');
      }

      if (groupV2Id) {
        const existing = byGroupV2Id[groupV2Id];
        if (!existing) {
          byGroupV2Id[groupV2Id] = conversation;
        } else {
          const logParenthetical = isGroupV1(conversation.attributes)
            ? ' (derived from a GV1 group ID)'
            : '';
          log.warn(
            `checkForConflicts: Found conflict with group V2 ID ${groupV2Id}${logParenthetical}`
          );

          // Prefer the GV2 group.
          if (
            isGroupV2(conversation.attributes) &&
            !isGroupV2(existing.attributes)
          ) {
            // eslint-disable-next-line no-await-in-loop
            await this.combineConversations(conversation, existing);
            byGroupV2Id[groupV2Id] = conversation;
          } else {
            // eslint-disable-next-line no-await-in-loop
            await this.combineConversations(existing, conversation);
          }
        }
      }
    }

    log.info('checkForConflicts: complete!');
  }

  async combineConversations(
    current: ConversationModel,
    obsolete: ConversationModel
  ): Promise<void> {
    const conversationType = current.get('type');

    if (obsolete.get('type') !== conversationType) {
      assert(
        false,
        'combineConversations cannot combine a private and group conversation. Doing nothing'
      );
      return;
    }

    const obsoleteId = obsolete.get('id');
    const obsoleteUuid = obsolete.getUuid();
    const currentId = current.get('id');
    log.warn('combineConversations: Combining two conversations', {
      obsolete: obsoleteId,
      current: currentId,
    });

    if (conversationType === 'private' && obsoleteUuid) {
      if (!current.get('profileKey') && obsolete.get('profileKey')) {
        log.warn(
          'combineConversations: Copying profile key from old to new contact'
        );

        const profileKey = obsolete.get('profileKey');

        if (profileKey) {
          await current.setProfileKey(profileKey);
        }
      }

      log.warn(
        'combineConversations: Delete all sessions tied to old conversationId'
      );
      const ourUuid = window.textsecure.storage.user.getCheckedUuid();
      const deviceIds = await window.textsecure.storage.protocol.getDeviceIds({
        ourUuid,
        identifier: obsoleteUuid.toString(),
      });
      await Promise.all(
        deviceIds.map(async deviceId => {
          const addr = new QualifiedAddress(
            ourUuid,
            new Address(obsoleteUuid, deviceId)
          );
          await window.textsecure.storage.protocol.removeSession(addr);
        })
      );

      log.warn(
        'combineConversations: Delete all identity information tied to old conversationId'
      );

      if (obsoleteUuid) {
        await window.textsecure.storage.protocol.removeIdentityKey(
          obsoleteUuid
        );
      }

      log.warn(
        'combineConversations: Ensure that all V1 groups have new conversationId instead of old'
      );
      const groups = await this.getAllGroupsInvolvingUuid(obsoleteUuid);
      groups.forEach(group => {
        const members = group.get('members');
        const withoutObsolete = without(members, obsoleteId);
        const currentAdded = uniq([...withoutObsolete, currentId]);

        group.set({
          members: currentAdded,
        });
        updateConversation(group.attributes);
      });
    }

    // Note: we explicitly don't want to update V2 groups

    log.warn(
      'combineConversations: Delete the obsolete conversation from the database'
    );
    await removeConversation(obsoleteId);

    log.warn('combineConversations: Update messages table');
    await migrateConversationMessages(obsoleteId, currentId);

    log.warn(
      'combineConversations: Eliminate old conversation from ConversationController lookups'
    );
    this._conversations.remove(obsolete);
    this._conversations.resetLookups();

    log.warn('combineConversations: Complete!', {
      obsolete: obsoleteId,
      current: currentId,
    });
  }

  /**
   * Given a groupId and optional additional initialization properties,
   * ensures the existence of a group conversation and returns a string
   * representing the local database ID of the group conversation.
   */
  ensureGroup(groupId: string, additionalInitProps = {}): string {
    return this.getOrCreate(groupId, 'group', additionalInitProps).get('id');
  }

  /**
   * Given certain metadata about a message (an identifier of who wrote the
   * message and the sent_at timestamp of the message) returns the
   * conversation the message belongs to OR null if a conversation isn't
   * found.
   */
  async getConversationForTargetMessage(
    targetFromId: string,
    targetTimestamp: number
  ): Promise<ConversationModel | null | undefined> {
    const messages = await getMessagesBySentAt(targetTimestamp);
    const targetMessage = messages.find(m => getContactId(m) === targetFromId);

    if (targetMessage) {
      return this.get(targetMessage.conversationId);
    }

    return null;
  }

  async getAllGroupsInvolvingUuid(
    uuid: UUID
  ): Promise<Array<ConversationModel>> {
    const groups = await getAllGroupsInvolvingUuid(uuid.toString());
    return groups.map(group => {
      const existing = this.get(group.id);
      if (existing) {
        return existing;
      }

      return this._conversations.add(group);
    });
  }

  getByDerivedGroupV2Id(groupId: string): ConversationModel | undefined {
    return this._conversations.find(
      item => item.get('derivedGroupV2Id') === groupId
    );
  }

  reset(): void {
    delete this._initialPromise;
    this._initialFetchComplete = false;
    this._conversations.reset([]);
  }

  load(): Promise<void> {
    this._initialPromise ||= this.doLoad();
    return this._initialPromise;
  }

  // A number of things outside conversation.attributes affect conversation re-rendering.
  //   If it's scoped to a given conversation, it's easy to trigger('change'). There are
  //   important values in storage and the storage service which change rendering pretty
  //   radically, so this function is necessary to force regeneration of props.
  async forceRerender(identifiers?: Array<string>): Promise<void> {
    let count = 0;
    const conversations = identifiers
      ? identifiers.map(identifier => this.get(identifier)).filter(isNotNil)
      : this._conversations.models.slice();
    log.info(
      `forceRerender: Starting to loop through ${conversations.length} conversations`
    );

    for (let i = 0, max = conversations.length; i < max; i += 1) {
      const conversation = conversations[i];

      if (conversation.cachedProps) {
        conversation.oldCachedProps = conversation.cachedProps;
        conversation.cachedProps = null;

        conversation.trigger('props-change', conversation, false);
        count += 1;
      }

      if (count % 10 === 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(300);
      }
    }
    log.info(`forceRerender: Updated ${count} conversations`);
  }

  onConvoOpenStart(conversationId: string): void {
    this._conversationOpenStart.set(conversationId, Date.now());
  }

  onConvoMessageMount(conversationId: string): void {
    const loadStart = this._conversationOpenStart.get(conversationId);
    if (loadStart === undefined) {
      return;
    }

    this._conversationOpenStart.delete(conversationId);
    this.get(conversationId)?.onOpenComplete(loadStart);
  }

  repairPinnedConversations(): void {
    const pinnedIds = window.storage.get('pinnedConversationIds', []);

    for (const id of pinnedIds) {
      const convo = this.get(id);

      if (!convo || convo.get('isPinned')) {
        continue;
      }

      log.warn(
        `ConversationController: Repairing ${convo.idForLogging()}'s isPinned`
      );
      convo.set('isPinned', true);

      window.Signal.Data.updateConversation(convo.attributes);
    }
  }

  private async doLoad(): Promise<void> {
    log.info('ConversationController: starting initial fetch');

    if (this._conversations.length) {
      throw new Error('ConversationController: Already loaded!');
    }

    try {
      const collection = await getAllConversations();

      // Get rid of temporary conversations
      const temporaryConversations = collection.filter(conversation =>
        Boolean(conversation.isTemporary)
      );

      if (temporaryConversations.length) {
        log.warn(
          `ConversationController: Removing ${temporaryConversations.length} temporary conversations`
        );
      }
      const queue = new PQueue({
        concurrency: 3,
        timeout: MINUTE * 30,
        throwOnTimeout: true,
      });
      queue.addAll(
        temporaryConversations.map(item => async () => {
          await removeConversation(item.id);
        })
      );
      await queue.onIdle();

      // Hydrate the final set of conversations
      this._conversations.add(
        collection.filter(conversation => !conversation.isTemporary)
      );

      this._initialFetchComplete = true;

      await Promise.all(
        this._conversations.map(async conversation => {
          try {
            // Hydrate contactCollection, now that initial fetch is complete
            conversation.fetchContacts();

            const isChanged = maybeDeriveGroupV2Id(conversation);
            if (isChanged) {
              updateConversation(conversation.attributes);
            }

            // In case a too-large draft was saved to the database
            const draft = conversation.get('draft');
            if (draft && draft.length > MAX_MESSAGE_BODY_LENGTH) {
              conversation.set({
                draft: draft.slice(0, MAX_MESSAGE_BODY_LENGTH),
              });
              updateConversation(conversation.attributes);
            }

            // Clean up the conversations that have UUID as their e164.
            const e164 = conversation.get('e164');
            const uuid = conversation.get('uuid');
            if (isValidUuid(e164) && uuid) {
              conversation.set({ e164: undefined });
              updateConversation(conversation.attributes);

              log.info(`Cleaning up conversation(${uuid}) with invalid e164`);
            }
          } catch (error) {
            log.error(
              'ConversationController.load/map: Failed to prepare a conversation',
              error && error.stack ? error.stack : error
            );
          }
        })
      );
      log.info('ConversationController: done with initial fetch');
    } catch (error) {
      log.error(
        'ConversationController: initial fetch failed',
        error && error.stack ? error.stack : error
      );
      throw error;
    }
  }
}
