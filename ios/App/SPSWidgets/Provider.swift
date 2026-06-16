//  Provider.swift
//  SPSWidgets — one TimelineProvider shared by every widget. It reads the cached
//  App Group payload and builds a single entry. The app pushes fresh data with
//  WidgetCenter.reloadAllTimelines() after writes; the hourly policy is just a
//  belt-and-braces fallback so dates/relative copy don't go stale.

import WidgetKit

struct SPSEntry: TimelineEntry {
    let date: Date
    let payload: WidgetPayload?
}

struct SPSProvider: TimelineProvider {
    func placeholder(in context: Context) -> SPSEntry {
        SPSEntry(date: Date(), payload: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (SPSEntry) -> Void) {
        completion(SPSEntry(date: Date(), payload: SharedStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SPSEntry>) -> Void) {
        let entry = SPSEntry(date: Date(), payload: SharedStore.load())
        let next = Calendar.current.date(byAdding: .hour, value: 1, to: Date())
            ?? Date().addingTimeInterval(3600)
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}
