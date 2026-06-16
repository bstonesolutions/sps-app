#!/usr/bin/env ruby
# add_widgets_target.rb — wires the SPSWidgets WidgetKit extension into App.xcodeproj.
# Idempotent: re-running removes the prior SPSWidgets target/group/embed phase first.
# Run from ios/App:  ruby add_widgets_target.rb
require 'xcodeproj'

PROJECT   = 'App.xcodeproj'
APP_NAME  = 'App'
WIDGET    = 'SPSWidgets'
APP_BUNDLE = 'com.stonepropertysolutions.app'
WIDGET_BUNDLE = 'com.stonepropertysolutions.app.SPSWidgets'
TEAM      = 'JASPHFVN38'
DEPLOY    = '15.0'
BUILD_NO  = '7'

proj = Xcodeproj::Project.open(PROJECT)
app  = proj.targets.find { |t| t.name == APP_NAME } or abort("App target not found")

# ---- 0. Clean any previous run -------------------------------------------------
proj.targets.select { |t| t.name == WIDGET }.each do |t|
  t.product_reference.remove_from_project rescue nil
  t.remove_from_project
end
app.dependencies.select { |d| d.target&.name == WIDGET || d.display_name == WIDGET }.each(&:remove_from_project)
app.copy_files_build_phases.select { |p| p.name == 'Embed App Extensions' }.each(&:remove_from_project)
if (g = proj.main_group.children.find { |c| c.display_name == WIDGET })
  g.remove_from_project
end

# ---- 1. Create the app-extension target ---------------------------------------
widget = proj.new_target(:app_extension, WIDGET, :ios, DEPLOY)

# ---- 2. Build settings (Debug + Release) --------------------------------------
widget.build_configurations.each do |c|
  bs = c.build_settings
  bs['PRODUCT_BUNDLE_IDENTIFIER']  = WIDGET_BUNDLE
  bs['PRODUCT_NAME']               = '$(TARGET_NAME)'
  bs['INFOPLIST_FILE']             = "#{WIDGET}/Info.plist"
  bs['GENERATE_INFOPLIST_FILE']    = 'NO'
  bs['CODE_SIGN_ENTITLEMENTS']     = "#{WIDGET}/#{WIDGET}.entitlements"
  bs['CODE_SIGN_STYLE']            = 'Automatic'
  bs['DEVELOPMENT_TEAM']           = TEAM
  bs['IPHONEOS_DEPLOYMENT_TARGET'] = DEPLOY
  bs['SWIFT_VERSION']              = '5.0'
  bs['MARKETING_VERSION']          = '1.0'
  bs['CURRENT_PROJECT_VERSION']    = BUILD_NO
  bs['TARGETED_DEVICE_FAMILY']     = '1,2'
  bs['SKIP_INSTALL']               = 'YES'
  bs['CLANG_ENABLE_MODULES']       = 'YES'
  bs['SWIFT_EMIT_LOC_STRINGS']     = 'YES'
  bs['INFOPLIST_KEY_CFBundleDisplayName'] = 'SPS Way'
  bs['LD_RUNPATH_SEARCH_PATHS']    = ['$(inherited)', '@executable_path/Frameworks',
                                      '@executable_path/../../Frameworks']
  bs['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = (c.name == 'Debug' ? 'DEBUG' : '')
  bs['SWIFT_OPTIMIZATION_LEVEL']   = (c.name == 'Debug' ? '-Onone' : '-O')
end

# ---- 3. Source group + files ---------------------------------------------------
group = proj.main_group.new_group(WIDGET, WIDGET)   # display name + path 'SPSWidgets'
swift = Dir.glob("#{WIDGET}/*.swift").sort.map { |f| File.basename(f) }
swift.each do |name|
  ref = group.new_reference(name)
  widget.source_build_phase.add_file_reference(ref)
end
# Non-compiled refs so Xcode shows them under the group.
group.new_reference('Info.plist')
group.new_reference("#{WIDGET}.entitlements")

# ---- 4. Main-app changes: bridge source, app-group entitlements ----------------
app_group_node = proj.main_group.children.find { |c| c.display_name == APP_NAME }
app_group_node ||= proj.main_group.new_group(APP_NAME, APP_NAME)
unless app_group_node.files.any? { |f| f.display_name == 'SPSWidgetBridge.swift' }
  bridge = app_group_node.new_reference('SPSWidgetBridge.swift')
  app.source_build_phase.add_file_reference(bridge)
end
unless app_group_node.files.any? { |f| f.display_name == 'App.entitlements' }
  app_group_node.new_reference('App.entitlements')
end
app.build_configurations.each do |c|
  c.build_settings['CODE_SIGN_ENTITLEMENTS'] = "#{APP_NAME}/App.entitlements"
end

# ---- 5. Embed the extension into the app + dependency --------------------------
app.add_dependency(widget)
embed = app.new_copy_files_build_phase('Embed App Extensions')
embed.symbol_dst_subfolder_spec = :plug_ins
bf = embed.add_file_reference(widget.product_reference, true)
bf.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

# Embed phase should run before the app is signed; xcodeproj appends it, which is fine.

proj.save
puts "OK: added #{WIDGET} target (#{swift.length} swift files), embedded into #{APP_NAME}."
puts "Targets now: #{proj.targets.map(&:name).join(', ')}"
