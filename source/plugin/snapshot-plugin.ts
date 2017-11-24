/**
 * @license Copyright © 2017 Nicholas Jamieson. All Rights Reserved.
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/cartant/rxjs-spy
 */

import { Observable } from "rxjs/Observable";
import { Subscriber } from "rxjs/Subscriber";
import { Subscription } from "rxjs/Subscription";
import { StackFrame } from "stacktrace-js";
import { getGraphRef, GraphRef } from "./graph-plugin";
import { identify } from "../identify";
import { read } from "../match";
import { BasePlugin, Notification } from "./plugin";
import { Spy } from "../spy-interface";
import { getSourceMapsResolved, getStackTrace } from "./stack-trace-plugin";
import { SubscriberRef, SubscriptionRef } from "../subscription-ref";
import { inferPath, inferType } from "../util";

const snapshotRefSymbol = Symbol("snapshotRef");

export interface SnapshotRef {
    complete: boolean;
    error: any;
    tick: number;
    timestamp: number;
    unsubscribed: boolean;
    values: { tick: number; timestamp: number; value: any; }[];
    valuesFlushed: number;
}

export function getSnapshotRef(ref: SubscriberRef): SnapshotRef {

    return ref[snapshotRefSymbol];
}

function setSnapshotRef(ref: SubscriberRef, value: SnapshotRef): SnapshotRef {

    ref[snapshotRefSymbol] = value;
    return value;
}

export interface Snapshot {
    observables: Map<Observable<any>, ObservableSnapshot>;
    sourceMapsResolved: Promise<void>;
    subscribers: Map<Subscriber<any>, SubscriberSnapshot>;
    subscriptions: Map<Subscription, SubscriptionSnapshot>;
    tick: number;
}

export interface ObservableSnapshot {
    id: string;
    observable: Observable<any>;
    path: string;
    subscriptions: Map<Subscription, SubscriptionSnapshot>;
    tag: string | undefined;
    tick: number;
    type: string;
}

export interface SubscriberSnapshot {
    id: string;
    subscriber: Subscriber<any>;
    subscriptions: Map<Subscription, SubscriptionSnapshot>;
    tick: number;
    values: { tick: number; timestamp: number; value: any; }[];
    valuesFlushed: number;
}

export interface SubscriptionSnapshot {
    complete: boolean;
    error: any;
    id: string;
    merges: Map<Subscription, SubscriptionSnapshot>;
    mergesFlushed: number;
    observable: Observable<any>;
    rootSink: SubscriptionSnapshot | undefined;
    sink: SubscriptionSnapshot | undefined;
    sourceMapsResolved: Promise<void>;
    sources: Map<Subscription, SubscriptionSnapshot>;
    sourcesFlushed: number;
    stackTrace: StackFrame[];
    subscriber: Subscriber<any>;
    subscription: Subscription;
    tick: number;
    timestamp: number;
    unsubscribed: boolean;
}

export class SnapshotPlugin extends BasePlugin {

    private keptValues_: number;
    private sentinel_: GraphRef | undefined;
    private spy_: Spy;

    constructor(spy: Spy, {
        keptValues = 4
    }: {
        keptValues?: number
    } = {}) {

        super("snapshot");

        this.keptValues_ = keptValues;
        this.sentinel_ = undefined;
        this.spy_ = spy;
    }

    afterUnsubscribe(ref: SubscriptionRef): void {

        const snapshotRef = getSnapshotRef(ref);
        snapshotRef.tick = this.spy_.tick;
        snapshotRef.unsubscribed = true;
    }

    beforeComplete(ref: SubscriptionRef): void {

        const snapshotRef = getSnapshotRef(ref);
        snapshotRef.tick = this.spy_.tick;
        snapshotRef.complete = true;
    }

    beforeError(ref: SubscriptionRef, error: any): void {

        const snapshotRef = getSnapshotRef(ref);
        snapshotRef.tick = this.spy_.tick;
        snapshotRef.error = error;
    }

    beforeNext(ref: SubscriptionRef, value: any): void {

        const tick = this.spy_.tick;
        const snapshotRef = getSnapshotRef(ref);
        snapshotRef.tick = tick;
        snapshotRef.values.push({ tick, timestamp: Date.now(), value });

        const { keptValues_ } = this;
        const count = snapshotRef.values.length - keptValues_;
        if (count > 0) {
            snapshotRef.values.splice(0, count);
            snapshotRef.valuesFlushed += count;
        }
    }

    beforeSubscribe(ref: SubscriberRef): void {

        const snapshotRef = setSnapshotRef(ref, {
            complete: false,
            error: undefined,
            tick: this.spy_.tick,
            timestamp: Date.now(),
            unsubscribed: false,
            values: [],
            valuesFlushed: 0
        });

        const graphRef = getGraphRef(ref);
        if (graphRef) {
            this.sentinel_ = graphRef.sentinel;
        } else {
            /*tslint:disable-next-line:no-console*/
            console.warn("Graphing is not enabled.");
        }
    }

    snapshotAll({
        since
    }: {
        since?: Snapshot
    } = {}): Snapshot {

        const observables = new Map<Observable<any>, ObservableSnapshot>();
        const promises: Promise<void>[] = [];
        const subscribers = new Map<Subscriber<any>, SubscriberSnapshot>();
        const subscriptions = new Map<Subscription, SubscriptionSnapshot>();

        const subscriptionRefs = this.getSubscriptionRefs_();
        subscriptionRefs.forEach((unused, ref) => {

            const { observable, subscriber, subscription } = ref;

            const graphRef = getGraphRef(ref);
            const { mergesFlushed, sourcesFlushed } = graphRef;

            const snapshotRef = getSnapshotRef(ref);
            const {
                complete,
                error,
                tick,
                timestamp,
                unsubscribed,
                values,
                valuesFlushed
            } = snapshotRef;

            const sourceMapsResolved = getSourceMapsResolved(ref);
            promises.push(sourceMapsResolved);

            const subscriptionSnapshot: SubscriptionSnapshot = {
                complete,
                error,
                id: identify(ref),
                merges: new Map<Subscription, SubscriptionSnapshot>(),
                mergesFlushed,
                observable,
                rootSink: undefined,
                sink: undefined,
                sourceMapsResolved,
                sources: new Map<Subscription, SubscriptionSnapshot>(),
                sourcesFlushed,
                stackTrace: getStackTrace(ref),
                subscriber,
                subscription,
                tick,
                timestamp,
                unsubscribed
            };
            subscriptions.set(subscription, subscriptionSnapshot);

            let subscriberSnapshot = subscribers.get(subscriber);
            if (!subscriberSnapshot) {
                subscriberSnapshot = {
                    id: identify(subscriber),
                    subscriber,
                    subscriptions: new Map<Subscription, SubscriptionSnapshot>(),
                    tick,
                    values: [],
                    valuesFlushed: 0
                };
                subscribers.set(subscriber, subscriberSnapshot);
            }
            subscriberSnapshot.subscriptions.set(subscription, subscriptionSnapshot);
            subscriberSnapshot.tick = Math.max(subscriberSnapshot.tick, tick);
            subscriberSnapshot.values.push(...values);
            subscriberSnapshot.valuesFlushed += valuesFlushed;

            let observableSnapshot = observables.get(observable);
            if (!observableSnapshot) {
                observableSnapshot = {
                    id: identify(observable),
                    observable,
                    path: inferPath(observable),
                    subscriptions: new Map<Subscription, SubscriptionSnapshot>(),
                    tag: read(observable),
                    tick,
                    type: inferType(observable)
                };
                observables.set(observable, observableSnapshot);
            }
            observableSnapshot.subscriptions.set(subscription, subscriptionSnapshot);
            observableSnapshot.tick = Math.max(observableSnapshot.tick, tick);
        });

        subscriptionRefs.forEach((unused, ref) => {

            const graphRef = getGraphRef(ref);
            const subscriptionSnapshot = subscriptions.get(ref.subscription)!;

            if (graphRef.sink) {
                subscriptionSnapshot.sink = subscriptions.get(graphRef.sink.subscription)!;
            }
            if (graphRef.rootSink) {
                subscriptionSnapshot.rootSink = subscriptions.get(graphRef.rootSink.subscription)!;
            }
            graphRef.merges.forEach((m) => subscriptionSnapshot.merges.set(m.subscription, subscriptions.get(m.subscription)!));
            graphRef.sources.forEach((s) => subscriptionSnapshot.sources.set(s.subscription, subscriptions.get(s.subscription)!));
        });

        subscribers.forEach((subscriberSnapshot) => {

            subscriberSnapshot.values.sort((a, b) => a.tick - b.tick);
        });

        if (since !== undefined) {

            observables.forEach((value, key) => {
                if (value.tick <= since.tick) {
                    observables.delete(key);
                }
            });

            subscribers.forEach((value, key) => {
                if (value.tick <= since.tick) {
                    subscribers.delete(key);
                }
            });

            subscriptions.forEach((value, key) => {
                if (value.tick <= since.tick) {
                    subscriptions.delete(key);
                }
            });
        }

        return {
            observables,
            sourceMapsResolved: Promise.all(promises).then(() => undefined),
            subscribers,
            subscriptions,
            tick: this.spy_.tick
        };
    }

    snapshotObservable(ref: SubscriptionRef): ObservableSnapshot | undefined {

        const snapshot = this.snapshotAll();
        return snapshot.observables.get(ref.observable);
    }

    snapshotSubscriber(ref: SubscriptionRef): SubscriberSnapshot | undefined {

        const snapshot = this.snapshotAll();
        return snapshot.subscribers.get(ref.subscriber);
    }

    private addSubscriptionRefs_(ref: SubscriptionRef, map: Map<SubscriptionRef, boolean>): void {

        map.set(ref, true);

        const graphRef = getGraphRef(ref);
        graphRef.merges.forEach((m) => this.addSubscriptionRefs_(m, map));
        graphRef.sources.forEach((s) => this.addSubscriptionRefs_(s, map));
    }

    private getSubscriptionRefs_(): Map<SubscriptionRef, boolean> {

        const { sentinel_ } = this;
        const map = new Map<SubscriptionRef, boolean>();

        if (sentinel_) {
            sentinel_.sources.forEach(ref => this.addSubscriptionRefs_(ref, map));
        }
        return map;
    }
}
