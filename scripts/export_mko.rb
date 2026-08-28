#!/usr/bin/env ruby
# frozen_string_literal: true

# Export every mn-samples-oiml document (in-tree compiled XML) as an MKO
# bundle. Run from the metanorma-document checkout (the MKO stack branch):
#
#   cd ~/src/mn/metanorma-document && bundle exec ruby /path/to/scripts/export_mko.rb
#
# Writes <out>/<slug>.mko directories. Deterministic: identical inputs give
# byte-identical bundles.

require "metanorma/document"
require "metanorma/iso/document"
require "metanorma/mko"

SRC = ENV["HOME"] + "/src/mn/mn-samples-oiml/sources"
OUT = ARGV[0] || "/tmp/mko-bundles"

DOCS = %w[
  b018-e18 b018-e25 b022-e23 d009-e04 d011-e13 d030 d032 d036-e20
  e006-e11 g021-e17 oiml-cs-cid-01 oiml-cs-od-01 oiml-cs-od-02
  oiml-cs-pd-01 oiml-cs-pd-02 oiml-cs-pd-03 oiml-cs-pd-04 oiml-cs-pd-05
  oiml-cs-pd-06 oiml-cs-pd-07 oiml-cs-pd-08 oiml-cs-pd-09 r007-e79
  r060/1 r060/2 r060/3 r060/a
  r129/1 r129/2 r129/3 r129/4
  r138-e07/amd-2009 r138-e07/main
  r144/1 r144/2 r144/3
]

ok = 0
DOCS.each do |src|
  xml  = File.read("#{SRC}/#{src}/document.xml")
  pres = File.read("#{SRC}/#{src}/document.presentation.xml")
  puts Metanorma::Mko.export(xml, to: OUT, presentation_xml: pres)
  ok += 1
rescue StandardError => e
  warn "FAIL #{src}: #{e.class}: #{e.message[0, 120]}"
end
puts "exported #{ok}/#{DOCS.size}"
exit(ok == DOCS.size ? 0 : 1)
