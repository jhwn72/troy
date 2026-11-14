//
//  PollSupport.m  (Troy addition)
//
//  Control channel for things BlueBubbles Server has no API for (polls).
//  Messages is sandboxed (network client only), so the helper CONNECTS OUT to Troy's
//  local control server at 127.0.0.1:45699, the same pattern BlueBubbles uses.
//
//  Config (inside Messages' sandbox container):
//    ~/Library/Containers/com.apple.MobileSMS/Data/Library/Application Support/troy-helper/config.json
//    {"token": "...", "allowedChats": ["any;-;..."]}
//
//  Protocol: newline-delimited JSON.
//    helper -> troy  {"hello":"troy-helper"}
//    troy   -> helper {"id":1,"token":"..","cmd":"get-payload","chatGuid":"..","messageGuid":".."}
//    troy   -> helper {"id":2,"token":"..","cmd":"send-balloon","chatGuid":"..","balloonBundleID":"..","payloadBase64":"..","text":".."}
//    helper -> troy  {"id":N,"ok":true,...} or {"id":N,"ok":false,"error":".."}
//  Every command needs the token and a chatGuid listed in allowedChats.
//

#import <Foundation/Foundation.h>
#import <os/log.h>
#import "GCDAsyncSocket.h"
#import "IMChat.h"
#import "IMChatRegistry.h"
#import "IMMessage.h"
#import "BlueBubblesHelper.h"

@interface BlueBubblesHelper (TroyPrivate)
+ (void)getMessageItem:(IMChat *)chat :(NSString *)actionMessageGuid completionBlock:(void (^)(IMMessage *message))block;
@end

static const uint16_t kTroyPort = 45699;

// Find My (FindMyLocateObjCWrapper) selectors used below, resolved at runtime inside Messages.
@protocol TroyFMLSession <NSObject>
- (void)sendFriendshipInviteToHandle:(id)handle isFromGroup:(BOOL)isFromGroup completion:(id)completion;
- (void)sendFriendshipInviteToHandle:(id)handle from:(id)fromHandle isFromGroup:(BOOL)isFromGroup completion:(id)completion;
- (void)getFriendsSharingLocationsWithMeWithCompletion:(id)completion;
- (void)startRefreshingLocationForHandles:(NSArray *)handles priority:(long long)priority isFromGroup:(BOOL)isFromGroup reverseGeocode:(BOOL)reverseGeocode completion:(id)completion;
- (id)cachedLocationForHandle:(id)handle includeAddress:(BOOL)includeAddress;
@end
@protocol TroyIMFMFSession <NSObject>
+ (instancetype)sharedInstance;
- (id)fmlSession;
@end

// The other person's handle for a 1:1 chat guid like "any;-;someone@icloud.com". nil for group chats.
static NSString *TroyHandleForChatGuid(NSString *chatGuid) {
    NSArray *parts = [chatGuid componentsSeparatedByString:@";"];
    if (parts.count != 3 || ![parts[1] isEqualToString:@"-"]) return nil;
    return parts[2];
}

static id<TroyFMLSession> TroyFMLSessionGet(void) {
    Class imfmf = NSClassFromString(@"IMFMFSession");
    if (!imfmf) return nil;
    id session = [[(id<TroyIMFMFSession>)imfmf sharedInstance] fmlSession];
    if (![session respondsToSelector:@selector(cachedLocationForHandle:includeAddress:)]) return nil;
    return session;
}

static id TroyFMLHandle(NSString *identifier) {
    Class c = NSClassFromString(@"FMLHandle");
    if (!c || ![c respondsToSelector:@selector(handleWithIdentifier:)]) return nil;
    return [c performSelector:@selector(handleWithIdentifier:) withObject:identifier];
}

static NSDictionary *TroyLocationDict(id loc) {
    if (!loc) return nil;
    NSMutableDictionary *d = [NSMutableDictionary new];
    for (NSString *k in @[@"latitude", @"longitude", @"horizontalAccuracy", @"verticalAccuracy", @"altitude", @"speed", @"timestamp", @"locationType", @"floorLevel"]) {
        @try { id v = [loc valueForKey:k]; if (v) d[k] = v; } @catch (NSException *e) {}
    }
    @try { id label = [loc valueForKey:@"coarseAddressLabel"]; if ([label isKindOfClass:[NSString class]]) d[@"coarseAddressLabel"] = label; } @catch (NSException *e) {}
    @try { id addr = [loc valueForKey:@"address"]; if (addr) d[@"address"] = [addr description] ?: @""; } @catch (NSException *e) {}
    return d;
}

@interface TroyControl : NSObject <GCDAsyncSocketDelegate>
@property (strong) GCDAsyncSocket *sock;
@property (strong) os_log_t log;
@end

@implementation TroyControl

+ (instancetype)shared {
    static TroyControl *s; static dispatch_once_t once;
    dispatch_once(&once, ^{ s = [TroyControl new]; s.log = os_log_create("BlueBubblesHelper", "troy"); });
    return s;
}

+ (void)load {
    if (![[[NSBundle mainBundle] bundleIdentifier] isEqualToString:@"com.apple.MobileSMS"]) return;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(6 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [[TroyControl shared] connect];
    });
}

- (NSDictionary *)config {
    NSString *path = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/troy-helper/config.json"];
    NSData *d = [NSData dataWithContentsOfFile:path];
    if (!d) return nil;
    id obj = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
    return [obj isKindOfClass:[NSDictionary class]] ? obj : nil;
}

- (void)connect {
    if (self.sock.isConnected) return;
    self.sock = [[GCDAsyncSocket alloc] initWithDelegate:self delegateQueue:dispatch_get_main_queue()];
    NSError *err = nil;
    if (![self.sock connectToHost:@"127.0.0.1" onPort:kTroyPort withTimeout:3 error:&err]) [self retryLater];
}

- (void)retryLater {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ [self connect]; });
}

- (void)socket:(GCDAsyncSocket *)sock didConnectToHost:(NSString *)host port:(uint16_t)port {
    os_log(self.log, "Troy control connected");
    [self send:@{@"hello": @"troy-helper", @"config": [self config] ? @YES : @NO}];
    [sock readDataToData:[GCDAsyncSocket LFData] withTimeout:-1 tag:0];
}

- (void)socketDidDisconnect:(GCDAsyncSocket *)sock withError:(NSError *)err {
    if (sock == self.sock) [self retryLater];
}

- (void)send:(NSDictionary *)obj {
    NSMutableData *d = [[NSJSONSerialization dataWithJSONObject:obj options:0 error:nil] mutableCopy];
    [d appendData:[GCDAsyncSocket LFData]];
    [self.sock writeData:d withTimeout:10 tag:0];
}

- (void)reply:(id)reqId :(NSDictionary *)obj {
    NSMutableDictionary *m = [obj mutableCopy];
    m[@"id"] = reqId ?: [NSNull null];
    [self send:m];
}

- (void)socket:(GCDAsyncSocket *)sock didReadData:(NSData *)data withTag:(long)tag {
    [sock readDataToData:[GCDAsyncSocket LFData] withTimeout:-1 tag:0];
    NSDictionary *req = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![req isKindOfClass:[NSDictionary class]]) return;
    id rid = req[@"id"];
    NSDictionary *cfg = [self config];
    if (!cfg) { [self reply:rid :@{@"ok": @NO, @"error": @"missing config"}]; return; }

    NSString *token = cfg[@"token"];
    if (![token isKindOfClass:[NSString class]] || token.length < 16 || ![req[@"token"] isKindOfClass:[NSString class]] || ![req[@"token"] isEqualToString:token]) {
        [self reply:rid :@{@"ok": @NO, @"error": @"unauthorized"}]; return;
    }
    NSString *chatGuid = req[@"chatGuid"];

    // Runtime allowlist changes (John, 2026-11-14: automatic, 1:1 chats only).
    // allow-chat: chat must be 1:1 and already exist in Messages (the student texted first). Saved to config.json.
    if ([req[@"cmd"] isEqualToString:@"allow-chat"] || [req[@"cmd"] isEqualToString:@"remove-chat"]) {
        BOOL adding = [req[@"cmd"] isEqualToString:@"allow-chat"];
        if (![chatGuid isKindOfClass:[NSString class]] || !TroyHandleForChatGuid(chatGuid)) {
            [self reply:rid :@{@"ok": @NO, @"error": @"1:1 chat guid required"}]; return;
        }
        if (adding && ![[IMChatRegistry sharedInstance] existingChatWithGUID:chatGuid]) {
            [self reply:rid :@{@"ok": @NO, @"error": @"chat does not exist in Messages yet"}]; return;
        }
        NSMutableDictionary *newCfg = [cfg mutableCopy];
        NSMutableArray *list = [([cfg[@"allowedChats"] isKindOfClass:[NSArray class]] ? cfg[@"allowedChats"] : @[]) mutableCopy];
        BOOL had = [list containsObject:chatGuid];
        if (adding && !had) [list addObject:chatGuid];
        if (!adding) [list removeObject:chatGuid];
        newCfg[@"allowedChats"] = list;
        NSString *path = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/troy-helper/config.json"];
        NSData *out = [NSJSONSerialization dataWithJSONObject:newCfg options:NSJSONWritingPrettyPrinted error:nil];
        BOOL saved = [out writeToFile:path options:NSDataWritingAtomic error:nil];
        os_log(self.log, "Troy allowlist: %{public}s one chat (changed=%d), now %lu allowed, saved=%d",
               adding ? "added" : "removed", adding ? !had : had, (unsigned long)list.count, saved);
        [self reply:rid :saved ? @{@"ok": @YES, @"changed": @(adding ? !had : had), @"count": @(list.count)} : @{@"ok": @NO, @"error": @"could not save config"}];
        return;
    }

    NSArray *allowed = cfg[@"allowedChats"];
    if (![chatGuid isKindOfClass:[NSString class]] || ![allowed isKindOfClass:[NSArray class]] || ![allowed containsObject:chatGuid]) {
        [self reply:rid :@{@"ok": @NO, @"error": @"chat not allowed"}]; return;
    }
    IMChat *chat = [[IMChatRegistry sharedInstance] existingChatWithGUID:chatGuid];
    if (!chat) { [self reply:rid :@{@"ok": @NO, @"error": @"chat not found"}]; return; }

    NSString *cmd = req[@"cmd"];
    @try {
        if ([cmd isEqualToString:@"get-payload"]) {
            NSString *mg = req[@"messageGuid"];
            if (![mg isKindOfClass:[NSString class]]) { [self reply:rid :@{@"ok": @NO, @"error": @"messageGuid required"}]; return; }
            [BlueBubblesHelper getMessageItem:chat :mg completionBlock:^(IMMessage *message) {
                if (!message) { [self reply:rid :@{@"ok": @NO, @"error": @"message not found"}]; return; }
                NSMutableDictionary *out = [@{@"ok": @YES} mutableCopy];
                if (message.balloonBundleID) out[@"balloonBundleID"] = message.balloonBundleID;
                if (message.payloadData) out[@"payloadBase64"] = [message.payloadData base64EncodedStringWithOptions:0];
                if (message.text.string) out[@"text"] = message.text.string;
                [self reply:rid :out];
            }];
        } else if ([cmd isEqualToString:@"send-balloon"]) {
            NSString *bundle = req[@"balloonBundleID"];
            NSString *b64 = [req[@"payloadBase64"] isKindOfClass:[NSString class]] ? req[@"payloadBase64"] : @"";
            NSData *payload = [[NSData alloc] initWithBase64EncodedString:b64 options:0];
            if (![bundle isKindOfClass:[NSString class]] || payload.length == 0) {
                [self reply:rid :@{@"ok": @NO, @"error": @"balloonBundleID and payloadBase64 required"}]; return;
            }
            NSString *text = [req[@"text"] isKindOfClass:[NSString class]] ? req[@"text"] : @"￼";
            NSAttributedString *att = [[NSAttributedString alloc] initWithString:text];
            IMMessage *m = [[IMMessage alloc] initWithSender:nil time:nil text:att messageSubject:nil fileTransferGUIDs:nil
                                                       flags:0x5 error:nil guid:nil subject:nil
                                             balloonBundleID:bundle payloadData:payload expressiveSendStyleID:nil];
            [chat sendMessage:m];
            [self reply:rid :@{@"ok": @YES, @"guid": [[chat lastSentMessage] guid] ?: @""}];
        } else if ([cmd isEqualToString:@"send-poll"]) {
            // Builds the same payload Messages uses for native polls (macOS 27 / iOS 26):
            // an NSKeyedArchiver NSDictionary whose URL is data:,<base64 JSON>?src=p&c=<option count>.
            NSArray *optionTexts = req[@"options"];
            NSString *creator = req[@"creatorHandle"];
            NSString *title = [req[@"title"] isKindOfClass:[NSString class]] ? req[@"title"] : @"";
            if (![optionTexts isKindOfClass:[NSArray class]] || optionTexts.count < 2 || optionTexts.count > 12 || ![creator isKindOfClass:[NSString class]]) {
                [self reply:rid :@{@"ok": @NO, @"error": @"need 2-12 options and creatorHandle"}]; return;
            }
            NSMutableArray *opts = [NSMutableArray new];
            NSMutableArray *ids = [NSMutableArray new];
            for (id t in optionTexts) {
                if (![t isKindOfClass:[NSString class]] || [t length] == 0) { [self reply:rid :@{@"ok": @NO, @"error": @"options must be non-empty strings"}]; return; }
                NSString *oid = [[NSUUID UUID] UUIDString];
                [ids addObject:oid];
                [opts addObject:@{@"attributedText": t, @"canBeEdited": @NO, @"optionIdentifier": oid, @"text": t, @"creatorHandle": creator}];
            }
            NSDictionary *json = @{@"version": @1, @"item": @{@"orderedPollOptions": opts, @"title": title, @"creatorHandle": creator}};
            NSData *jsonData = [NSJSONSerialization dataWithJSONObject:json options:0 error:nil];
            NSString *urlString = [NSString stringWithFormat:@"data:,%@?src=p&c=%lu", [jsonData base64EncodedStringWithOptions:0], (unsigned long)opts.count];
            NSData *live = [NSKeyedArchiver archivedDataWithRootObject:@{@"userInfo": @{}, @"layoutClass": @"MSMessageLiveLayout"} requiringSecureCoding:NO error:nil];
            NSDictionary *root = @{
                @"layoutClass": @"MSMessageTemplateLayout",
                @"URL": [NSURL URLWithString:urlString],
                @"ldtext": @"Sent a poll",
                @"userInfo": @{@"caption": @"Sent a poll", @"image-title": @"", @"secondary-subcaption": @"", @"tertiary-subcaption": @"", @"image-subtitle": @"", @"subcaption": @""},
                @"sessionIdentifier": [NSUUID UUID],
                @"liveLayoutInfo": live,
                @"an": @"Polls",
            };
            NSData *payload = [NSKeyedArchiver archivedDataWithRootObject:root requiringSecureCoding:NO error:nil];
            NSString *bundle = @"com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.messages.Polls";
            IMMessage *m = [[IMMessage alloc] initWithSender:nil time:nil text:[[NSAttributedString alloc] initWithString:@"￼"] messageSubject:nil
                                           fileTransferGUIDs:nil flags:0x5 error:nil guid:nil subject:nil
                                             balloonBundleID:bundle payloadData:payload expressiveSendStyleID:nil];
            [chat sendMessage:m];
            [self reply:rid :@{@"ok": @YES, @"guid": [[chat lastSentMessage] guid] ?: @"", @"optionIdentifiers": ids}];
        } else if ([cmd isEqualToString:@"location-request"] || [cmd isEqualToString:@"location-get"] || [cmd isEqualToString:@"location-friends"]) {
            // Only ever acts on the other person in an allowed 1:1 chat.
            NSString *who = TroyHandleForChatGuid(chatGuid);
            id<TroyFMLSession> session = TroyFMLSessionGet();
            id handle = who ? TroyFMLHandle(who) : nil;
            if (!who || !session || !handle) {
                [self reply:rid :@{@"ok": @NO, @"error": !who ? @"1:1 chats only" : !session ? @"Find My session unavailable" : @"could not make handle"}]; return;
            }
            if ([cmd isEqualToString:@"location-request"]) {
                // Apple's "ask to follow": the person gets a Find My request to share their location with this Apple ID.
                // (invite is sent after the bubble below; the reply waits for Find My's answer)
                // Also send the "Requested Location" Find My bubble, built like the one iOS 26 sends:
                // URL ?FindMyMessagePayloadVersionKey=v0&FindMyMessagePayloadZippedDataKey=<base64(raw deflate(JSON)), '=' and '+' percent-encoded>
                NSString *bubbleGuid = @"";
                if (![req[@"bubble"] isEqual:@NO]) {
                    NSDictionary *json = @{@"kind": @{@"request": @{}}, @"timestamp": @([[NSDate date] timeIntervalSinceReferenceDate]),
                                           @"isFromResend": @NO, @"id": [[NSUUID UUID] UUIDString]};
                    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:json options:0 error:nil];
                    NSData *zipped = [jsonData compressedDataUsingAlgorithm:NSDataCompressionAlgorithmZlib error:nil]; // raw DEFLATE
                    NSString *b64 = [[[zipped base64EncodedStringWithOptions:0] stringByReplacingOccurrencesOfString:@"=" withString:@"%3D"]
                                     stringByReplacingOccurrencesOfString:@"+" withString:@"%2B"];
                    NSString *urlString = [NSString stringWithFormat:@"?FindMyMessagePayloadVersionKey=v0&FindMyMessagePayloadZippedDataKey=%@", b64];
                    NSData *live = [NSKeyedArchiver archivedDataWithRootObject:@{@"userInfo": @{}, @"layoutClass": @"MSMessageLiveLayout"} requiringSecureCoding:NO error:nil];
                    NSDictionary *root = @{
                        @"URL": [NSURL URLWithString:urlString],
                        @"an": @"Find My",
                        @"layoutClass": @"MSMessageTemplateLayout",
                        @"ldtext": @"Requested Location",
                        @"liveLayoutInfo": live,
                        @"userInfo": @{@"caption": @"", @"image-title": @"", @"secondary-subcaption": @"", @"tertiary-subcaption": @"", @"image-subtitle": @"", @"subcaption": @""},
                    };
                    NSData *payload = [NSKeyedArchiver archivedDataWithRootObject:root requiringSecureCoding:NO error:nil];
                    NSString *bundle = @"com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.findmy.FindMyMessagesApp";
                    IMMessage *m = [[IMMessage alloc] initWithSender:nil time:nil text:[[NSAttributedString alloc] initWithString:@"￼"] messageSubject:nil
                                                   fileTransferGUIDs:nil flags:0x5 error:nil guid:nil subject:nil
                                                     balloonBundleID:bundle payloadData:payload expressiveSendStyleID:nil];
                    [chat sendMessage:m];
                    bubbleGuid = [[chat lastSentMessage] guid] ?: @"";
                }
                // Ask Find My, and reply when it answers (or after 10 s), so Troy can see why a request fails.
                __block BOOL answered = NO;
                void (^finish)(NSString *) = ^(NSString *result) {
                    if (answered) return; answered = YES;
                    [self reply:rid :@{@"ok": @YES, @"requested": who, @"invite": result, @"bubbleGuid": bubbleGuid}];
                };
                id fromHandle = [req[@"fromHandle"] isKindOfClass:[NSString class]] ? TroyFMLHandle(req[@"fromHandle"]) : nil;
                void (^inviteDone)(id) = ^(id err) {
                    // The completion's argument type isn't declared; only treat it as an object if it looks like a real pointer.
                    uintptr_t p = (uintptr_t)(__bridge void *)err;
                    NSString *r;
                    if (err == nil) r = @"ok";
                    else if (p > 0x100000 && (p & 0x7) == 0 && [err isKindOfClass:[NSError class]]) r = [NSString stringWithFormat:@"error: %@ (%@ %ld)", [(NSError *)err localizedDescription], [(NSError *)err domain], (long)[(NSError *)err code]];
                    else r = [NSString stringWithFormat:@"completed with value %lu", (unsigned long)p];
                    dispatch_async(dispatch_get_main_queue(), ^{ finish(r); });
                };
                if (fromHandle && [(id)session respondsToSelector:@selector(sendFriendshipInviteToHandle:from:isFromGroup:completion:)])
                    [session sendFriendshipInviteToHandle:handle from:fromHandle isFromGroup:NO completion:inviteDone];
                else
                    [session sendFriendshipInviteToHandle:handle isFromGroup:NO completion:inviteDone];
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ finish(@"no answer from Find My within 10s"); });
            } else if ([cmd isEqualToString:@"location-friends"]) {
                [session getFriendsSharingLocationsWithMeWithCompletion:^(NSArray *friends) {
                    BOOL sharing = NO;
                    NSString *target = [who lowercaseString];
                    for (id f in friends) {
                        @try {
                            NSString *ident = [[f valueForKey:@"handle"] valueForKey:@"identifier"];
                            if ([ident isKindOfClass:[NSString class]] && [[ident lowercaseString] isEqualToString:target]) { sharing = YES; break; }
                        } @catch (NSException *e) {}
                    }
                    // Never report anyone else; only whether the allowed handle is sharing.
                    dispatch_async(dispatch_get_main_queue(), ^{ [self reply:rid :@{@"ok": @YES, @"handle": who, @"sharingWithMe": @(sharing)}]; });
                }];
            } else {
                // Turn on live tracking for this person, the way Messages does when you open their details.
                @try {
                    id imfmf = [NSClassFromString(@"IMFMFSession") performSelector:@selector(sharedInstance)];
                    id recipient = [chat respondsToSelector:@selector(recipient)] ? [chat performSelector:@selector(recipient)] : nil;
                    if (recipient && [imfmf respondsToSelector:@selector(startTrackingLocationForHandle:)]) {
                        [imfmf performSelector:@selector(startTrackingLocationForHandle:) withObject:recipient];
                    }
                } @catch (NSException *e) { os_log_error(self.log, "Troy: startTracking failed %{public}@", e.reason); }
                // Use Find My's own handle object for this friend (a hand-made FMLHandle may not match its cache).
                [session getFriendsSharingLocationsWithMeWithCompletion:^(NSArray *friends) {
                    id friendHandle = nil;
                    NSString *target = [who lowercaseString];
                    for (id f in friends) {
                        @try {
                            id h = [f valueForKey:@"handle"];
                            NSString *ident = [h valueForKey:@"identifier"];
                            if ([ident isKindOfClass:[NSString class]] && [[ident lowercaseString] isEqualToString:target]) { friendHandle = h; break; }
                        } @catch (NSException *e) {}
                    }
                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (!friendHandle) { [self reply:rid :@{@"ok": @YES, @"handle": who, @"sharingWithMe": @NO, @"location": [NSNull null]}]; return; }
                        __block BOOL answered = NO;
                        void (^answer)(void) = ^{
                            if (answered) return; answered = YES;
                            id loc = [session cachedLocationForHandle:friendHandle includeAddress:YES];
                            if (!loc) loc = [session cachedLocationForHandle:handle includeAddress:YES];
                            NSDictionary *d = TroyLocationDict(loc);
                            [self reply:rid :@{@"ok": @YES, @"handle": who, @"sharingWithMe": @YES, @"location": d ?: [NSNull null]}];
                        };
                        long long prio = [req[@"priority"] isKindOfClass:[NSNumber class]] ? [req[@"priority"] longLongValue] : 1000;
                        [session startRefreshingLocationForHandles:@[friendHandle] priority:prio isFromGroup:NO reverseGeocode:YES completion:^{
                            // The refresh completion can fire before the new fix lands; give it a moment.
                            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)), dispatch_get_main_queue(), answer);
                        }];
                        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC)), dispatch_get_main_queue(), answer);
                    });
                }];
            }
        } else {
            [self reply:rid :@{@"ok": @NO, @"error": @"unknown cmd"}];
        }
    } @catch (NSException *e) {
        os_log_error(self.log, "Troy control exception: %{public}@", e);
        [self reply:rid :@{@"ok": @NO, @"error": [NSString stringWithFormat:@"exception: %@", e.reason ?: e.name]}];
    }
}

@end
