/**
 * @license
 * Copyright (c) 2015 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import * as fs from 'fs';
import * as jsonschema from 'jsonschema';
import * as path from 'path';
import * as util from 'util';

import {Analysis} from './analysis';
import {BehaviorDescriptor, Descriptor, DocumentDescriptor, ElementDescriptor, ImportDescriptor, InlineDocumentDescriptor, PropertyDescriptor} from './ast/ast';
import {Attribute, Element, Elements, Event, Property, SourceLocation} from './elements-format';
import {JsonDocument} from './json/json-document';
import {Document} from './parser/document';
import {trimLeft} from './utils';


export function generateElementMetadata(
    analysis: Analysis, packagePath: string): Elements|undefined {
  const elementDescriptors = analysis.getElementsForPackage(packagePath);
  if (!elementDescriptors) {
    return undefined;
  }
  return {
    schema_version: '1.0.0',
    elements: elementDescriptors.map(
        e => serializeElementDescriptor(
            e, analysis.elementPaths.get(e), analysis))
  };
}

function serializeElementDescriptor(
    elementDescriptor: ElementDescriptor, path: string,
    analysis: Analysis): Element|null {
  if (!elementDescriptor.is) {
    return null;
  }
  const behaviors =
      getFlattenedAndResolvedBehaviors(elementDescriptor.behaviors, analysis);
  const propertiesByName = new Map<string, PropertyDescriptor>();
  for (const prop of elementDescriptor.properties) {
    propertiesByName.set(prop.name, prop);
  }
  for (const behavior of behaviors) {
    for (const prop of behavior.properties) {
      if (!propertiesByName.has(prop.name)) {
        propertiesByName.set(prop.name, prop);
      }
    }
  }

  const properties = Array.from(propertiesByName.values());
  const propChangeEvents: Event[] =
      properties.filter(p => p.notify && propertyToAttributeName(p.name))
          .map(p => ({
                 name: `${propertyToAttributeName(p.name)}-changed`,
                 type: 'CustomEvent',
                 description: `Fired when the \`${p.name}\` property changes.`
               }));

  return {
    tagname: elementDescriptor.is,
    description: elementDescriptor.desc || '',
    superclass: 'HTMLElement',
    path: path,
    attributes: computeAttributesFromPropertyDescriptors(properties),
    properties: properties.map(serializePropertyDescriptor),
    styling: {
      cssVariables: [],
      selectors: [],
    },
    demos: (elementDescriptor.demos || []).map(d => d.path),
    slots: [],
    events: propChangeEvents,
    metadata: {},
    sourceLocation: elementDescriptor.sourceLocation
  };
}

function serializePropertyDescriptor(propertyDescriptor: PropertyDescriptor):
    Property {
  const property: Property = {
    name: propertyDescriptor.name,
    type: propertyDescriptor.type || '?',
    description: propertyDescriptor.desc || '',
    sourceLocation: propertyDescriptor.sourceLocation
  };
  if (propertyDescriptor.default) {
    property.defaultValue = JSON.stringify(propertyDescriptor.default);
  }
  const polymerMetadata: any = {};
  const polymerMetadataFields = ['notify', 'observer', 'readOnly'];
  for (const field of polymerMetadataFields) {
    if (field in propertyDescriptor) {
      polymerMetadata[field] = propertyDescriptor[field];
    }
  }
  property.metadata = {polymer: polymerMetadata};
  return property;
}

function getFlattenedAndResolvedBehaviors(
    behaviors: (string | BehaviorDescriptor)[], analysis: Analysis) {
  const resolvedBehaviors = new Set<BehaviorDescriptor>();
  _getFlattenedAndResolvedBehaviors(behaviors, analysis, resolvedBehaviors);
  return resolvedBehaviors;
}

function _getFlattenedAndResolvedBehaviors(
    behaviors: (string | BehaviorDescriptor)[], analysis: Analysis,
    resolvedBehaviors: Set<BehaviorDescriptor>) {
  const toLookup = behaviors.slice();
  for (let behavior of toLookup) {
    if (typeof behavior === 'string') {
      const behaviorName = behavior;
      behavior = analysis.getBehavior(behavior);
      if (!behavior) {
        throw new Error(
            `Unable to resolve behavior \`${behaviorName}\` ` +
            `Did you import it? Is it annotated with @polymerBehavior?`);
      }
    }
    if (resolvedBehaviors.has(behavior)) {
      continue;
    }
    resolvedBehaviors.add(behavior);
    _getFlattenedAndResolvedBehaviors(
        behavior.behaviors, analysis, resolvedBehaviors);
  }
}

function computeAttributesFromPropertyDescriptors(props: PropertyDescriptor[]):
    Attribute[] {
  return props.filter(prop => propertyToAttributeName(prop.name)).map(prop => {
    const attribute: Attribute = {
      name: propertyToAttributeName(prop.name),
      description: prop.desc || '',
      sourceLocation: prop.sourceLocation
    };
    if (prop.type) {
      attribute.type = prop.type;
    }
    if (prop.default) {
      attribute.type = prop.type;
    }
    return attribute;
  });
}

/**
 * Implements Polymer core's translation of property names to attribute names.
 *
 * Returns null if the property name cannot be so converted.
 */
function propertyToAttributeName(propertyName: string): string|null {
  // Polymer core will not map a property name that starts with an uppercase
  // character onto an attribute.
  if (propertyName[0].toUpperCase() === propertyName[0]) {
    return null;
  }
  return propertyName.replace(
      /([A-Z])/g, (_: string, c1: string) => `-${c1.toLowerCase()}`);
}
