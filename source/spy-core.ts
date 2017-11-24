/**
 * @license Copyright © 2017 Nicholas Jamieson. All Rights Reserved.
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/cartant/rxjs-spy
 */

import { BehaviorSubject } from "rxjs/BehaviorSubject";
import { Observable } from "rxjs/Observable";
import { Subject } from "rxjs/Subject";
import { Subscriber } from "rxjs/Subscriber";
import { Subscription } from "rxjs/Subscription";
import { detect, hook } from "./detect";
import { Detector } from "./detector";
import { identify } from "./identify";
import { defaultLogger, Logger, PartialLogger, toLogger } from "./logger";
import { Match, matches, toString as matchToString } from "./match";

import {
    DebugPlugin,
    Deck,
    DevToolsPlugin,
    GraphPlugin,
    LetPlugin,
    LogPlugin,
    Notification,
    PausePlugin,
    Plugin,
    SnapshotPlugin,
    StackTracePlugin,
    StatsPlugin,
    SubscriptionSnapshot
} from "./plugin";

import { wrap } from "./spy-console";
import { Ctor, Spy, Teardown } from "./spy-interface";
import { SubscriberRef, SubscriptionRef } from "./subscription-ref";
import { isObservable, toSubscriber } from "./util";

import "rxjs/add/operator/let";

const observableSubscribe = Observable.prototype.subscribe;

export class SpyCore implements Spy {

    private static spy_: SpyCore | undefined = undefined;

    private defaultLogger_: PartialLogger;
    private plugins_: Plugin[];
    private pluginsSubject_: BehaviorSubject<Plugin[]>;
    private teardown_: Teardown | undefined;
    private tick_: number;
    private undos_: Plugin[];

    constructor(options: {
        [key: string]: any,
        defaultLogger?: PartialLogger,
        plugins?: Plugin[],
        warning?: boolean
    } = {}) {

        if (SpyCore.spy_) {
            throw new Error("Already spying on Observable.prototype.subscribe.");
        }
        if (options.warning) {
            /*tslint:disable-next-line:no-console*/
            console.warn("Spying on Observable.prototype.subscribe.");
        }

        SpyCore.spy_ = this;
        Observable.prototype.subscribe = SpyCore.coreSubscribe_;

        this.defaultLogger_ = options.defaultLogger || defaultLogger;
        if (options.defaultPlugins ===  false) {
            this.plugins_ = [];
        } else {
            this.plugins_ = [
                new StackTracePlugin(options as { [key: string]: any }),
                new GraphPlugin(options as { [key: string]: any }),
                new SnapshotPlugin(this, options as { [key: string]: any }),
                new StatsPlugin(this),
                new DevToolsPlugin(this)
            ];
        }
        this.pluginsSubject_ = new BehaviorSubject(this.plugins_);
        this.tick_ = 0;
        this.undos_ = [];

        const detector = new Detector(this.find(SnapshotPlugin));
        hook((id) => this.detect_(id, detector));

        if (typeof window !== "undefined") {
            window["rxSpy"] = wrap(this);
        }

        this.teardown_ = () => {

            if (typeof window !== "undefined") {
                delete window["rxSpy"];
            }

            hook(undefined);
            this.plugins_.forEach((plugin) => plugin.teardown());
            this.plugins_ = [];
            this.pluginsSubject_.next(this.plugins_);
            this.undos_ = [];

            SpyCore.spy_ = undefined;
            Observable.prototype.subscribe = observableSubscribe;
        };
    }

    get tick(): number {

        return this.tick_;
    }

    get undos(): Plugin[] {

        return [...this.undos_];
    }

    debug(match: Match, ...notifications: Notification[]): Teardown {

        if (notifications.length === 0) {
            notifications = ["complete", "error", "next", "subscribe", "unsubscribe"];
        }
        return this.plug(new DebugPlugin(match, notifications));
    }

    find<T extends Plugin>(ctor: Ctor<T>): T | undefined {

        const found = this.plugins_.find((plugin) => plugin instanceof ctor);
        return found ? found as T : undefined;
    }

    findAll<T extends Plugin>(ctor: Ctor<T>): T[];
    findAll(): Plugin[];
    findAll<T extends Plugin>(ctor?: Ctor<T>): T[] | Plugin[] {

        return ctor ?
            this.plugins_.filter((plugin) => plugin instanceof ctor) as T[] :
            this.plugins_;
    }

    flush(): void {

        this.plugins_.forEach((plugin) => plugin.flush());
    }

    ignore<R>(block: () => R): R {

        SpyCore.spy_ = undefined;
        try {
            return block();
        } catch (error) {
            throw error;
        } finally {
            SpyCore.spy_ = this;
        }
    }

    let(match: Match, select: (source: Observable<any>) => Observable<any>): Teardown {

        return this.plug(new LetPlugin(match, select));
    }

    log(partialLogger?: PartialLogger): Teardown;
    log(match: Match, partialLogger?: PartialLogger): Teardown;
    log(match: any, partialLogger?: PartialLogger): Teardown {

        const anyTagged = /.+/;
        if (!match) {
            match = anyTagged;
        } else if (typeof match.log === "function") {
            partialLogger = match;
            match = anyTagged;
        }

        return this.plug(new LogPlugin(match, partialLogger || this.defaultLogger_));
    }

    pause(match: Match): Deck {

        const pausePlugin = new PausePlugin(this, match);
        const teardown = this.plug(pausePlugin);

        const deck = pausePlugin.deck;
        deck.teardown = teardown;
        return deck;
    }

    plug(...plugins: Plugin[]): Teardown {

        this.plugins_.push(...plugins);
        this.pluginsSubject_.next(this.plugins_);

        this.undos_.push(...plugins);
        return () => this.unplug(...plugins);
    }

    show(partialLogger?: PartialLogger): void;
    show(match: Match, partialLogger?: PartialLogger): void;
    show(match: any, partialLogger?: PartialLogger): void {

        const anyTagged = /.+/;
        if (!match) {
            match = anyTagged;
        } else if (typeof match.log === "function") {
            partialLogger = match;
            match = anyTagged;
        }

        const snapshotPlugin = this.find(SnapshotPlugin);
        if (!snapshotPlugin) {
            /*tslint:disable-next-line:no-console*/
            console.warn("Snapshotting is not enabled.");
            return;
        }

        const snapshot = snapshotPlugin.snapshotAll();
        const filtered = Array
            .from(snapshot.observables.values())
            .filter((observableSnapshot) => matches(observableSnapshot.observable, match));
        const logger = toLogger(partialLogger || this.defaultLogger_);
        const observableGroupMethod = (filtered.length > 3) ? "groupCollapsed" : "group";

        logger.group(`${filtered.length} snapshot(s) matching ${matchToString(match)}`);
        filtered.forEach((observableSnapshot) => {

            const { subscriptions } = observableSnapshot;
            logger[observableGroupMethod].call(logger, observableSnapshot.tag ?
                `Tag = ${observableSnapshot.tag}` :
                `Type = ${observableSnapshot.type}`
            );

            const subscriberGroupMethod = (subscriptions.size > 3) ? "groupCollapsed" : "group";
            logger.group(`${subscriptions.size} subscriber(s)`);
            subscriptions.forEach((subscriptionSnapshot) => {

                const subscriberSnapshot = snapshot.subscribers.get(subscriptionSnapshot.subscriber);
                if (subscriberSnapshot) {

                    const { values, valuesFlushed } = subscriberSnapshot;
                    logger[subscriberGroupMethod].call(logger, "Subscriber");
                    logger.log("Value count =", values.length + valuesFlushed);
                    if (values.length > 0) {
                        logger.log("Last value =", values[values.length - 1].value);
                    }
                    logSubscription(subscriptionSnapshot);

                    const otherSubscriptions = Array
                        .from(subscriberSnapshot.subscriptions.values())
                        .filter((otherSubscriptionSnapshot) => otherSubscriptionSnapshot !== subscriptionSnapshot);
                    otherSubscriptions.forEach((otherSubscriptionSnapshot) => {
                        logger.groupCollapsed("Other subscription");
                        logSubscription(otherSubscriptionSnapshot);
                        logger.groupEnd();
                    });
                    logger.groupEnd();
                } else {
                    logger.warn("Cannot find subscriber snapshot");
                }
            });
            logger.groupEnd();
            logger.groupEnd();
        });
        logger.groupEnd();

        function logSubscription(subscriptionSnapshot: SubscriptionSnapshot): void {

            const { complete, error, rootSink, stackTrace, unsubscribed } = subscriptionSnapshot;
            logger.log("State =", complete ? "complete" : error ? "error" : "incomplete");
            if (error) {
                logger.error("Error =", error);
            }
            if (unsubscribed) {
                logger.error("Unsubscribed =", true);
            }
            logger.log("Root subscribe", rootSink ? rootSink.stackTrace : stackTrace);
        }
    }

    stats(partialLogger?: PartialLogger): void {

        const statsPlugin = this.find(StatsPlugin);
        if (!statsPlugin) {
            /*tslint:disable-next-line:no-console*/
            console.warn("Stats are not enabled.");
            return;
        }

        const stats = statsPlugin.stats;
        const { leafSubscribes, maxDepth, mergedSubscribes, rootSubscribes, totalDepth } = stats;
        const logger = toLogger(partialLogger || this.defaultLogger_);
        logger.group("Stats");
        logger.log("subscribes =", stats.subscribes);
        if (rootSubscribes > 0) {
            logger.log("root subscribes =", rootSubscribes);
        }
        if (leafSubscribes > 0) {
            logger.log("leaf subscribes =", leafSubscribes);
        }
        if (mergedSubscribes > 0) {
            logger.log("merged subscribes =", mergedSubscribes);
        }
        logger.log("unsubscribes =", stats.unsubscribes);
        logger.log("nexts =", stats.nexts);
        logger.log("errors =", stats.errors);
        logger.log("completes =", stats.completes);
        if (maxDepth > 0) {
            logger.log("max. depth =", maxDepth);
            logger.log("avg. depth =", (totalDepth / leafSubscribes).toFixed(1));
        }
        logger.log("tick =", stats.tick);
        logger.log("timespan =", stats.timespan);
        logger.groupEnd();
    }

    teardown(): void {

        if (this.teardown_) {
            this.teardown_();
            this.teardown_ = undefined;
        }
    }

    unplug(...plugins: Plugin[]): void {

        plugins.forEach((plugin) => {
            plugin.teardown();
            this.plugins_ = this.plugins_.filter((p) => p !== plugin);
            this.pluginsSubject_.next(this.plugins_);
            this.undos_ = this.undos_.filter((u) => u !== plugin);
        });
    }

    /*tslint:disable-next-line:member-ordering*/
    private static coreSubscribe_(this: Observable<any>, ...args: any[]): Subscription {

        /*tslint:disable-next-line:no-invalid-this*/
        const observable = this;

        const { spy_ } = SpyCore;
        if (!spy_) {
            return observableSubscribe.apply(observable, args);
        }
        const notify_ = (before: (plugin: Plugin) => void, block: () => void, after: (plugin: Plugin) => void) => {
            ++spy_.tick_;
            spy_.plugins_.forEach(before);
            block();
            spy_.plugins_.forEach(after);
        };

        const subscriber = toSubscriber.apply(undefined, args);
        identify(observable);
        identify(subscriber);

        const ref: SubscriptionRef = {
            observable,
            subscriber,
            subscription: undefined!,
            timestamp: Date.now(),
            unsubscribed: false
        };
        identify(ref);

        interface PostLetObserver {
            complete: () => void;
            error: (error: any) => void;
            next: (value: any) => void;
            unsubscribed: boolean;
        }

        /*tslint:disable:no-invalid-this*/
        const postLetObserver: PostLetObserver = {

            complete(this: PostLetObserver): void {

                notify_(
                    (plugin) => plugin.beforeComplete(ref),
                    () => subscriber.complete(),
                    (plugin) => plugin.afterComplete(ref)
                );
            },

            error(this: PostLetObserver, error: any): void {

                if (!(error instanceof Error)) {
                    /*tslint:disable-next-line:no-console*/
                    console.warn("Value passed as error notification is not an Error instance =", error);
                }
                notify_(
                    (plugin) => plugin.beforeError(ref, error),
                    () => subscriber.error(error),
                    (plugin) => plugin.afterError(ref, error)
                );
            },

            next(this: PostLetObserver, value: any): void {

                notify_(
                    (plugin) => plugin.beforeNext(ref, value),
                    () => subscriber.next(value),
                    (plugin) => plugin.afterNext(ref, value)
                );
            },

            unsubscribed: false
        };
        /*tslint:enable:no-invalid-this*/
        const postLetSubscriber = toSubscriber(
            postLetObserver.next.bind(postLetObserver),
            postLetObserver.error.bind(postLetObserver),
            postLetObserver.complete.bind(postLetObserver)
        );

        interface PreLetObserver {
            complete: () => void;
            completed: boolean;
            error: (error: any) => void;
            errored: boolean;
            let: (plugins: Plugin[]) => void;
            next: (value: any) => void;
            postLetSubscriber: Subscriber<any>;
            postLetSubscription: Subscription | undefined;
            preLetSubject: Subject<any> | undefined;
            unsubscribed: boolean;
        }

        /*tslint:disable:no-invalid-this*/
        const preLetObserver: PreLetObserver = {

            complete(this: PreLetObserver): void {

                this.completed = true;

                if (this.preLetSubject) {
                    this.preLetSubject.complete();
                } else {
                    this.postLetSubscriber.complete();
                }
            },

            completed: false,

            error(this: PreLetObserver, error: any): void {

                this.errored = true;

                if (this.preLetSubject) {
                    this.preLetSubject.error(error);
                } else {
                    this.postLetSubscriber.error(error);
                }
            },

            errored: false,

            let(this: PreLetObserver, plugins: Plugin[]): void {

                const selectors = plugins.map((plugin) => plugin.select(ref)).filter(Boolean);
                if (selectors.length > 0) {

                    if (!this.preLetSubject) {
                        this.preLetSubject = new Subject<any>();
                    }
                    if (this.postLetSubscription) {
                        this.postLetSubscription.unsubscribe();
                    }

                    let source = this.preLetSubject.asObservable();
                    selectors.forEach(selector => source = source.let(selector!));
                    this.postLetSubscription = spy_.ignore(() => source.subscribe({
                        complete: () => this.postLetSubscriber.complete(),
                        error: (error: any) => this.postLetSubscriber.error(error),
                        next: (value: any) => this.postLetSubscriber.next(value)
                    }));

                } else if (this.postLetSubscription) {

                    this.postLetSubscription.unsubscribe();
                    this.postLetSubscription = undefined;
                    this.preLetSubject = undefined;
                }
            },

            next(this: PreLetObserver, value: any): void {

                if (this.preLetSubject) {
                    this.preLetSubject.next(value);
                } else {
                    this.postLetSubscriber.next(value);
                }
            },

            postLetSubscriber,
            postLetSubscription: undefined,
            preLetSubject: undefined,
            unsubscribed: false
        };
        /*tslint:enable:no-invalid-this*/
        const preLetSubscriber = toSubscriber(
            preLetObserver.next.bind(preLetObserver),
            preLetObserver.error.bind(preLetObserver),
            preLetObserver.complete.bind(preLetObserver)
        );

        const pluginsSubscription = spy_.ignore(() => spy_.pluginsSubject_.subscribe({
            next: (plugins: any) => preLetObserver.let(plugins)
        }));

        const preLetUnsubscribe = preLetSubscriber.unsubscribe;
        preLetSubscriber.unsubscribe = () => {

            if (!preLetObserver.unsubscribed) {

                preLetObserver.unsubscribed = true;

                if (!preLetObserver.completed && !preLetObserver.errored) {
                    if (preLetObserver.postLetSubscription) {
                        preLetObserver.postLetSubscription.unsubscribe();
                        preLetObserver.postLetSubscription = undefined;
                    }
                    preLetObserver.postLetSubscriber.unsubscribe();
                }
            }
            preLetUnsubscribe.call(preLetSubscriber);
        };
        subscriber.add(preLetSubscriber);

        const postLetUnsubscribe = postLetSubscriber.unsubscribe;
        postLetSubscriber.unsubscribe = () => {

            if (!postLetObserver.unsubscribed) {

                postLetObserver.unsubscribed = true;

                notify_(
                    (plugin) => plugin.beforeUnsubscribe(ref),
                    () => {
                        postLetUnsubscribe.call(postLetSubscriber);
                        pluginsSubscription.unsubscribe();
                        ref.unsubscribed = true;
                    },
                    (plugin) => plugin.afterUnsubscribe(ref)
                );

            } else {
                postLetUnsubscribe.call(postLetSubscriber);
            }
        };

        notify_(
            (plugin) => plugin.beforeSubscribe(ref),
            () => ref.subscription = observableSubscribe.call(observable, preLetSubscriber),
            (plugin) => plugin.afterSubscribe(ref)
        );
        return ref.subscription;
    }

    private detect_(id: string, detector: Detector): void {

        const detected = detector.detect(id);
        const logger = toLogger(this.defaultLogger_);

        if (detected) {
            logger.group(`Subscription changes detected; id = '${id}'`);
            detected.subscriptions.forEach((s) => {
                logSubscription(logger, "Subscription", s);
            });
            detected.unsubscriptions.forEach((s) => {
                logSubscription(logger, "Unsubscription", s);
            });
            detected.mergeSubscriptions.forEach((s) => {
                logSubscription(logger, "Merge subscription", s);
            });
            detected.mergeUnsubscriptions.forEach((s) => {
                logSubscription(logger, "Merge unsubscription", s);
            });
            logger.groupEnd();
        }

        function logSubscription(logger: Logger, name: string, subscription: SubscriptionSnapshot): void {

            logger.group(name);
            logger.log("Root subscribe", subscription.rootSink ?
                subscription.rootSink.stackTrace :
                subscription.stackTrace
            );
            logger.log("Subscribe", subscription.stackTrace);
            logger.groupEnd();
        }
    }
}
