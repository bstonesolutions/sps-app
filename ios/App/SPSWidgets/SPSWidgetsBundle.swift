//  SPSWidgetsBundle.swift
//  SPSWidgets — the widget extension entry point. Registers every widget the
//  user can add: three owner widgets, two client widgets.

import WidgetKit
import SwiftUI

@main
struct SPSWidgetsBundle: WidgetBundle {
    var body: some Widget {
        OwnerStopsWidget()
        OwnerProfitWidget()
        OwnerInvoiceWidget()
        ClientScheduleWidget()
        ClientBalanceWidget()
    }
}
