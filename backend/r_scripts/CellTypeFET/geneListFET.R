###################################################################################################################
# Cross-species FET modified to optionally adjust for symbol lookup inefficiency/loss
# by Eric Dammer & Divya Nandakumar
#-------------------------------------------------------------------------#
# +2/10/19 improved duplicate removal within and across reference lists
# +2/10/19 added toggles and speciescode for biomaRt lookup as parameters
# +8/11/20 fixed calculations to match divya's (swapped moduleList and categories vars, and removed unique() for totProteomeLength
# +5/08/21 added barOption - Divya style barplots
# +1/26/23 Converted to geneListFET function for Levi Wood ALS/FTD network collaboration
# +4/17/23 Added RColorBrewer palette specification to parameter/variable paletteColors (vector of length=# of marker list file inputs),
#          vector character strings must be one of the sequential (first group) or qualitative (third group) palettes shown by:
#          RColorBrewer::display.brewer.all()
#-------------------------------------------------------------------------#
# revisited to define fly cell types in Seurat 87 lists 2/10/2019
# Analysis for Laura Volpicelli, mouse a-Syn Bilaterally Injected Brain Regions 2/15/2019
# LFQ-MEGA Cell Type analysis performed with this code, with grey proteins added back in to totProteome, allGenes  4/5/2019 #***## (2 lines)
#=========================================================================#
geneListFET <- function(modulesInMemory=TRUE,categoriesFile=NA,categorySpeciesCode=NA,resortListsDecreasingSize=FALSE,barOption=FALSE,adjustFETforLookupEfficiency=FALSE,allowDuplicates=TRUE,
                        refDataFiles=NA,speciesCode=NA,refDataDescription="RefList(s)_not_described",FileBaseName="geneListFET_to_RefList(s)",paletteColors="YlGnBu",
                        heatmapTitle="Heatmap Title (not specified)", heatmapScale="minusLogFDR", verticalCompression=3, rootdir="./", outputDirName=NULL, reproduceHistoricCalc=FALSE, env=.GlobalEnv) {

require(WGCNA,quietly=TRUE)
require(RColorBrewer,quietly=TRUE)
require(biomaRt,quietly=TRUE)

if (!is.null(outputDirName)) {
  outputDir <- file.path(rootdir, outputDirName)
  if (!dir.exists(outputDir)) dir.create(outputDir, recursive = TRUE)
  refDataDir <- rootdir  # Input files stay in current directory
  outputfigs <- outputtabs <- paste0(outputDir, "/")  # Only outputs go to new directory
} else {
  refDataDir <- outputfigs <- outputtabs <- rootdir
}


if(!modulesInMemory) {  # Read in Categories as list 
  # old format: 2 column .csv with Symbol and "ClusterID" columns
  #  enumeratedListsDF<-read.csv(file=paste0(refDataDir,"/",categoriesFile),header=TRUE)
  #  enumeratedLists<-list()
  #  for(eachList in unique(enumeratedListsDF[,"ClusterID"])) { enumeratedLists[[as.character(eachList)]] <- enumeratedListsDF[which(enumeratedListsDF$ClusterID==eachList),"GeneSymbol"] }

  # new format: multicolumn .csv with Symbols or UniqueIDs and each cluster's symbols in a separate column with clusterID as column name (in row 1)
	enumeratedLists <- as.list(read.csv(paste0(refDataDir,categoriesFile), stringsAsFactors=FALSE,header=T,check.names=FALSE)) 
	names(enumeratedLists)
		
	#number of entries with no blanks
	length(unlist(lapply(enumeratedLists,function(x) x[!x==''] )))
	#take out blanks from list
	enumeratedLists <- lapply(enumeratedLists,function(x) x[!x==''] )
	#are there symbols duplicated? (yes, if below result is less than above)
	length(unique(unlist(enumeratedLists)))
	
	
	enumeratedLists<-lapply(enumeratedLists,function(x) as.data.frame(do.call("rbind",strsplit(x,"[|]")))[,1] )
	# leave duplicated symbols within each module/category list -
	#enumeratedLists<-lapply(enumeratedLists,unique)
	
	# leave duplicates in the clusters or modules being checked - they should contribute to overlap/enrichmend with reference lists more than once if duplicated.
	#if(!allowDuplicates) {
	#  while( length(unique(unlist(enumeratedLists))) < length(unlist(enumeratedLists)) ) {
	#    duplicatedvec<-unique(unlist(enumeratedLists)[which(duplicated(unlist(enumeratedLists)))])
	#    #remove duplicates from any marker list
	#    enumeratedLists<-lapply(enumeratedLists,function(x) { remIndices=as.vector(na.omit(match(duplicatedvec,x))); if (length(remIndices)>0) { x[-remIndices] } else { x }; } )
	#  }
	#}

} else {  # use WGCNA modules in memory

  # Module lookup table
  nModules<-length(table(net$colors))-1
  modules<-cbind(colnames(as.matrix(table(net$colors))),table(net$colors))
  orderedModules<-cbind(Mnum=paste("M",seq(1:nModules),sep=""),Color=WGCNA::labels2colors(c(1:nModules)))
  modules<-modules[match(as.character(orderedModules[,2]),rownames(modules)),]
  #as.data.frame(cbind(orderedModules,Size=modules))

  # Recalculate Consensus Cohort Eigengenes, i.e. eigenproteins and their relatedness order
  MEs<-data.frame()
  MEList = WGCNA::moduleEigengenes(t(cleanDat), colors = net$colors)
  MEs = orderMEs(MEList$eigengenes)
  net$MEs <- MEs
  colnames(MEs)<-gsub("ME","",colnames(MEs)) #let's be consistent in case prefix was added, remove it.
  rownames(MEs)<-rownames(numericMeta)
  if("grey" %in% colnames(MEs)) MEs[,"grey"] <- NULL

  # Make list of module member gene product official symbols
  enumeratedLists<-sapply( colnames(MEs),function(x) as.vector(data.frame(do.call("rbind",strsplit(rownames(cleanDat),"[|]")))[,1])[which(net$colors==x)] )
  greyToAddToTotProteome<- as.vector( data.frame(do.call("rbind",strsplit(rownames(cleanDat),"[|]")))[,1])[which(net$colors=="grey")] #***##
}
moduleList=enumeratedLists



pdf(file=paste0(outputfigs,"/",FileBaseName,".Overlap.in.",refDataDescription,".pdf"),height=15,width=24) 
############

#***iterating through multiple files (each one a page of output PDF):  
iter=0
for (refDataFile in refDataFiles) {
	iter=iter+1
	this.heatmapScale<-heatmapScale
	
	
	refData <- as.list(read.csv(paste0(refDataDir,refDataFile), stringsAsFactors = FALSE,header=T,check.names=FALSE)) 
	names(refData)
	
	
	#number of entries with no blanks
	length(unlist(lapply(refData,function(x) x[!x==''] )))
	#take out blanks from list
	refData <- lapply(refData,function(x) x[!x==''] )
	#are there symbols duplicated? (yes, if below result is less than above)
	length(unique(unlist(refData)))
	
	##Remove duplicates from all lists if allowDuplicates=FALSE
	#remove duplicated exact symbols within each list regardless:
	if (reproduceHistoricCalc) refData<-lapply(refData,unique)
	refData<-lapply(refData,function(x) as.data.frame(do.call("rbind",strsplit(x,"[|]")))[,1] )
	if (!reproduceHistoricCalc) refData<-lapply(refData,unique)
	
	if(!allowDuplicates) {
	  while( length(unique(unlist(refData))) < length(unlist(refData)) ) {
	    duplicatedvec<-unique(unlist(refData)[which(duplicated(unlist(refData)))])
	    #remove duplicates from any marker list
	    refData<-lapply(refData,function(x) { remIndices=as.vector(na.omit(match(duplicatedvec,x))); if (length(remIndices)>0) { x[-remIndices] } else { x }; } )
	  }
	  duplicateHandling="DuplicatesREMOVED"
	} else {
	  duplicateHandling="DuplicatesALLOWED"
	}
	length(unlist(refData))
	unlist(refData)[which(duplicated(unlist(refData)))]
	refDataMouse<-refData
	
	groupvec<-placeholders<-vector()
	for (i in 1:length(names(refData))) {
		placeholders=c(placeholders,rep(i,length(refData[[i]])))
		groupvec=c(groupvec,rep(names(refData)[i],length(refData[[i]])))
	}
	categoriesData<-data.frame(UniqueID=unlist(refData),Color=labels2colors(placeholders), Annot=groupvec,Mnum=paste0("M",placeholders)) #,row.names=unlist(refData)) #will not work if allowDuplicates==TRUE
	#^holding refData all lists' items, not modules gene symbols
	
	categoriesNameMatcher<-unique(categoriesData[,2:4])
	rownames(categoriesNameMatcher)<-NULL
	
	
	if(!categorySpeciesCode==speciesCode[iter]) {
	  cat(paste0("Converting ",speciesCode[iter]," to ",categorySpeciesCode," for lists in ",refDataFile," ... "))
	
	  this.heatmapTitle=paste0(heatmapTitle," in ",categorySpeciesCode," homologs")
	  #library(biomaRt)
	
	  #human = useEnsembl("genes", dataset = "hsapiens_gene_ensembl", host="https://dec2021.archive.ensembl.org")  #ver=105 equivalent to dec2021
	  #mouse = useEnsembl("genes", dataset = "mmusculus_gene_ensembl", host="https://dec2021.archive.ensembl.org") 
	
	  category.species = useEnsembl("genes", dataset=paste0(categorySpeciesCode,"_gene_ensembl"), host="https://dec2021.archive.ensembl.org")  #ver=105 equivalent to dec2021  ; old code: #useMart("ensembl",dataset=paste0(categorySpeciesCode,"_gene_ensembl"))
	  other = useEnsembl("genes", dataset=paste0(speciesCode[iter],"_gene_ensembl"), host="https://dec2021.archive.ensembl.org")   # old code: #useMart("ensembl",dataset=paste0(speciesCode[iter],"_gene_ensembl"))
	
	  #category species to other species conversion (first column is other species)
	  if(speciesCode[iter]=="hsapiens") {
	    genelist.mouseConv<-getLDS(attributes=c("hgnc_symbol"), filters="hgnc_symbol", values=categoriesData$UniqueID, mart=other, attributesL="external_gene_name",martL = category.species)
	    categoriesData$BiomartFlySymbol <- genelist.mouseConv[match(categoriesData$UniqueID,genelist.mouseConv$HGNC.symbol),"Gene.name"]
	  } else {
	    if(categorySpeciesCode=="hsapiens") {
	      genelist.mouseConv<-getLDS(attributes=c("external_gene_name"), filters="external_gene_name", values=categoriesData$UniqueID, mart=other, attributesL="hgnc_symbol",martL = category.species)
	      categoriesData$BiomartFlySymbol <- genelist.mouseConv[match(categoriesData$UniqueID,genelist.mouseConv$Gene.name),"HGNC.symbol"]
	    } else {
	      genelist.mouseConv<-getLDS(attributes=c("external_gene_name"), filters="external_gene_name", values=categoriesData$UniqueID, mart=other, attributesL="external_gene_name",martL = category.species)
	      categoriesData$BiomartFlySymbol <- genelist.mouseConv[match(categoriesData$UniqueID,genelist.mouseConv$Gene.name),"Gene.name.1"]
	    }
	  }
	} else { this.heatmapTitle=heatmapTitle }
	
	categoriesData.original<-categoriesData
	
	categoriesData.reducedFly<-na.omit(categoriesData)
	categoriesData.reducedFly$MouseID.original<-categoriesData.reducedFly$UniqueID
	if(!categorySpeciesCode==speciesCode[iter]) categoriesData.reducedFly$UniqueID<-categoriesData.reducedFly$BiomartFlySymbol
	categoriesData.reducedFly<-categoriesData.reducedFly[,-5]
	
	refDataFly<-list()
	for (i in unique(categoriesData.reducedFly$Annot)) {
		refDataFly[[i]]<-unique(categoriesData.reducedFly$UniqueID[which(categoriesData.reducedFly$Annot==i)])
	}
	refDataFly.original<-refDataFly
	
	#remove within-list duplicates from any marker list (some homologs map to multiple reference species unique genes)
	refDataFly<-lapply(refDataFly,unique)
	#final check
	length(unlist(refDataFly))
	unlist(refDataFly)[which(duplicated(unlist(refDataFly)))] #any duplicates across lists allowed
	length(unlist(refDataFly))==length(unique(unlist(refDataFly))) #false if duplicates across lists.
	
	refData<-refDataFly
	
	#make data frame of all markers
	mouseSymbolVec<-groupvec<-placeholders<-vector()
	for (i in 1:length(names(refData))) {
		placeholders=c(placeholders,rep(i,length(refData[[i]])))
		groupvec=c(groupvec,rep(names(refData)[i],length(refData[[i]])))
		mouseSymbolVec=c(groupvec,rep(names(refData)[i],length(refData[[i]])))
	}
	categoriesData<-data.frame(UniqueID=unlist(refData),Color=labels2colors(placeholders), Annot=groupvec,Mnum=paste0("M",placeholders))  #,row.names=unlist(refData))
	categoriesData$MouseSymbol=categoriesData.reducedFly$MouseID.original[match(categoriesData$UniqueID,categoriesData.reducedFly$UniqueID)]
	
	categoriesNameMatcher<-unique(categoriesData[,2:4])
	rownames(categoriesNameMatcher)<-NULL
	
	
	
	if(modulesInMemory) {
	  allGenes<- c(unlist(moduleList),greyToAddToTotProteome)  #unique() here decreases significance, totProteomeLength; Not in original code.
	} else {
	  allGenes<- unlist(enumeratedLists)  #ANOVAout$Symbol  #here the background is all measured proteins, #categoriesData$BiomartMouseSymbol
	}
	allGenesNetwork <- as.matrix(allGenes,stringsAsFactors = FALSE) 
	
	categories <- list()
	categoryNames=names(refData) #reference list names
	for (i in 1:length(categoryNames)) {
		element<-categoryNames[i]
		categories[[element]] <- categoriesData$UniqueID[which(categoriesData$Annot==categoryNames[i])]  #categoriesData$BiomartMouseSymbol[which(categoriesData$colors==modcolors[i])]
	}
	
	##+#+#+#+#+#+#+#+#+#+#+#+#+
	# Final Data Cleaning
	
	nModules <- length(names(moduleList))
	nCategories <- length(names(categories))
	
	for (a in 1:nCategories) {
		categories[[a]] <- unique(categories[[a]][categories[[a]] != ""])
		categories[[a]] <- categories[[a]][!is.na(categories[[a]])]
	}
	for (b in 1:nModules) {
		moduleList[[b]] <- unique(moduleList[[b]][moduleList[[b]] != ""])
	}
	
	if(resortListsDecreasingSize) {
	  categories <- categories[order(sapply(categories,length),decreasing=T)]
	  #only sort lists if 'moduleList' is not a list of WGCNA modules (keep them in relatedness order if they are)
	  if (!modulesInMemory) moduleList <- moduleList[order(sapply(moduleList,length),decreasing=T)]
	} #if FALSE, do not resort lists -- we have them in a precise order already
	
	
	allGenes_cleaned <- na.omit(allGenesNetwork)
	totProteomeLength <- length(allGenes_cleaned)
	if(max(sapply(refData,length))>totProteomeLength) {
	  cat (paste0("One of your reference data lists is larger than the background from the categories (WGCNA or specified categories file--all symbols)!\nUsing the bigger number for Fisher Exact would change all stats. Skipping ",refDataFile,".\n\n"))
	  next
	}
	
	### Fisher's Exact Test
	
	cat(paste0("Performing FET for lists [",iter,"] now.\n"))
	
	
	###swap cell type lists to categories and module members to moduleList (they are backwards up till here)
	#categories.bak<-categories
	#categories<-moduleList
	#moduleList<-categories.bak
	#nModules <- length(names(moduleList))
	#nCategories <- length(names(categories))
	
	FTpVal <- matrix(,nrow = nModules, ncol = nCategories)
	categoryOverlap <- matrix(,nrow = nModules, ncol = nCategories) 
	numCategoryHitsInDataset <- numCategoryHitsInDataset.UNADJ <- matrix(,nrow = nModules, ncol = nCategories) 
	CategoryHitsInDataset <- list()
	hitLists<-matrix(NA,nrow=nModules,ncol=nCategories) #use a matrix of collapsed (";") gene list strings
	ADJRedundancyAfterLookup=1 #length(unlist(refDataFly.original))/length(unlist(refDataFly)) #bigger than 1
	ADJforCrossSpeciesLookupFailure=nrow(categoriesData)/nrow(categoriesData.original) #less than 1
	totProteomeLength.ADJ <- as.integer(totProteomeLength*ADJforCrossSpeciesLookupFailure*ADJRedundancyAfterLookup)
	RefDataElements<-Categories1<-vector()
	
	for (i in 1:nModules){
		sampleSize <- length(moduleList[[i]])
		RefDataElements=c(RefDataElements,names(moduleList)[i])
		for (j in 1:nCategories){
			if(i==1) { Categories1=c(Categories1,names(categories)[j]) }
			#CategoryHitsInProteome <- categories[[j]] ## If using all of the markers and not just markers in proteome
			CategoryHitsInProteome <- intersect(categories[[j]],allGenesNetwork[,1])
			if (!adjustFETforLookupEfficiency) {
			  ##Unadjusted calculations:
			  numCategoryHitsInProteome <- length(CategoryHitsInProteome) 
			  numNonCategoryHitsInProteome <- totProteomeLength - numCategoryHitsInProteome
			  overlapGenes <- intersect(moduleList[[i]],CategoryHitsInProteome)
			  numOverlap <- length(overlapGenes)
			  otherCategories <- sampleSize - numOverlap
			  notInModule <- numCategoryHitsInProteome - numOverlap
			  notInMod_otherCategories <- totProteomeLength - numCategoryHitsInProteome - otherCategories
			} else {  ##allGenesNetwork has different species Symbols, and categories are also from that full Symbol List, so adjust for comparison to interconverted list overlap
			  #&& adjustments noted
			  numCategoryHitsInProteome <- as.integer(length(CategoryHitsInProteome)*(ADJforCrossSpeciesLookupFailure*ADJRedundancyAfterLookup)) #&& adjusted down for lookup inefficiency
			  numCategoryHitsInProteome.UNADJ <- length(CategoryHitsInProteome)
			  numNonCategoryHitsInProteome <- totProteomeLength.ADJ - numCategoryHitsInProteome #first term is adjusted
			  overlapGenes <- intersect(moduleList[[i]],CategoryHitsInProteome) #does not need adjustment, both subject to lower lookup efficiency
	
			  numOverlap <- length(overlapGenes)
			  otherCategories <- sampleSize - numOverlap
			  notInModule <- numCategoryHitsInProteome - numOverlap #&&using down-adjusted number numCategoryHitsInProteome for lookup efficiency
			  notInMod_otherCategories <- totProteomeLength - numCategoryHitsInProteome - otherCategories #&&first term not adjusted down because this is non-overlap so lookup inefficiency does not apply
									#&& but second term is adjusted because it it the hits subject to lookup efficiency
			}
			hitLists[i,j]<-paste(overlapGenes,collapse=";")
			contingency <- matrix(c(numOverlap,otherCategories,notInModule,notInMod_otherCategories),nrow=2,ncol=2,dimnames=list(c("GenesHit","GenesNotHit"),c("withinCategory","inProteome")))
	#debugging:     if(i==6 & j==3) cat(contingency)
			FT <- fisher.test(contingency,alternative="greater") #variable with presumed explanatory effect should be the row definitions, if known. (can transpose, but no effect on outcome p values)
			FTpVal[i,j] <- FT$p.value
			categoryOverlap[i,j] <- numOverlap
			numCategoryHitsInDataset[i,j] <- numCategoryHitsInProteome
			numCategoryHitsInDataset.UNADJ[i,j] <- if(adjustFETforLookupEfficiency) { numCategoryHitsInProteome.UNADJ } else { numCategoryHitsInProteome }
			if (i==1){
				CategoryHitsInDataset[[j]] <- array(CategoryHitsInProteome)
			}		
		}
	}
	
	
	#moduleList<-categories
	#categories<-categories.bak
	#nModules <- length(names(moduleList))
	#nCategories <- length(names(categories))
	
	
	rownames(FTpVal) <- RefDataElements
	colnames(FTpVal) <- Categories1
	rownames(categoryOverlap) <- RefDataElements
	colnames(categoryOverlap) <- Categories1
	colnames(numCategoryHitsInDataset) <- Categories1
	rownames(numCategoryHitsInDataset) <- RefDataElements
	names(CategoryHitsInDataset) <- Categories1
	rownames(hitLists) <- RefDataElements
	colnames(hitLists) <- Categories1
	
	
	#### Format Data for Plotting ########
	
	NegLogUncorr <- -log10(FTpVal)
	rownames(NegLogUncorr) <- rownames(FTpVal)
	colnames(NegLogUncorr) <- colnames(FTpVal)
	NegLogUncorr <- as.matrix(NegLogUncorr)
	
	nCategories = ncol(FTpVal)
	nModules = nrow(FTpVal)
	
	FisherspVal <- unlist(FTpVal)
	adjustedPVal <- p.adjust(FisherspVal, method = "fdr", n=length(FisherspVal))
	adjustedPval <- matrix(adjustedPVal,nrow=nModules,ncol=nCategories)
	rownames(adjustedPval) <- rownames(FTpVal)
	colnames(adjustedPval) <- colnames(FTpVal)
	NegLogCorr <- -log10(adjustedPval)
	
	## Transpose above stats and hits matrices
	categoryOverlap<-t(categoryOverlap)
	numCategoryHitsInDataset<-t(numCategoryHitsInDataset)
	numCategoryHitsInDataset.UNADJ<-t(numCategoryHitsInDataset.UNADJ)
	CategoryHitsInDataset<-t(CategoryHitsInDataset)
	hitLists<-t(hitLists)
	NegLogUncorr<-t(NegLogUncorr)
	NegLogCorr<-t(NegLogCorr)
	adjustedPval<-t(adjustedPval)
	FTpVal<-t(FTpVal)
	
	
	##Make sure colors are in correct (WGCNA) order before changing to numbered modules!
	if(modulesInMemory) {
	  orderedLabels<-cbind(paste("M",seq(1:nCategories),sep=""),labels2colors(c(1:nCategories)))
	} else {
	  orderedLabels<- cbind(paste("M",seq(1:nModules),sep=""),labels2colors(c(1:nModules))) #these go from M1 to M(# of reference lists)
	}
	
	#if you want the modules in order of relatedness from the module relatedness dendrogram:
	if(!modulesInMemory) {
	  orderedLabelsByRelatedness<- orderedLabels #(this is chronol. order)
	  if (!length(na.omit(match(orderedLabelsByRelatedness[,2],RefDataElements)))==nrow(orderedLabelsByRelatedness)) orderedLabelsByRelatedness[,2]<- RefDataElements; dummyColors=orderedLabelsByRelatedness[,2]; # our category/cluster names on categoriesFile row 1 are not WGCNA colors.
	  NegLogUncorr<-NegLogUncorr[,match(orderedLabelsByRelatedness[,2],colnames(NegLogUncorr))]
	  NegLogCorr<-NegLogCorr[,match(orderedLabelsByRelatedness[,2],colnames(NegLogCorr))]
	  adjustedPval<-adjustedPval[,match(orderedLabelsByRelatedness[,2],colnames(adjustedPval))]
	  FTpVal<-FTpVal[,match(orderedLabelsByRelatedness[,2],colnames(FTpVal))]
	} else {
	  orderedLabelsByRelatedness<- cbind( orderedLabels[ match(gsub("ME","",colnames(MEs)),orderedLabels[,2]) ,1] ,gsub("ME","",colnames(MEs)) )
	
	  NegLogUncorr<-NegLogUncorr[,match(orderedLabelsByRelatedness[,2],colnames(NegLogUncorr))]
	  NegLogCorr<-NegLogCorr[,match(orderedLabelsByRelatedness[,2],colnames(NegLogCorr))]
	  adjustedPval<-adjustedPval[,match(orderedLabelsByRelatedness[,2],colnames(adjustedPval))]
	  FTpVal<-FTpVal[,match(orderedLabelsByRelatedness[,2],colnames(FTpVal))]
	}
	xlabels <- orderedLabelsByRelatedness[,1]
	
	
	
	
	
	### Write p Values to a table/file
	#rownames(hitLists)<-categoriesNameMatcher$Annot[match(rownames(categoryOverlap),categoriesNameMatcher$Annot)]
	#rownames(FTpVal)<-categoriesNameMatcher$Annot[match(rownames(FTpVal),categoriesNameMatcher$Annot)]
	#rownames(adjustedPval)<-categoriesNameMatcher$Annot[match(rownames(adjustedPval),categoriesNameMatcher$Annot)]
	#rownames(categoryOverlap)<-categoriesNameMatcher$Annot[match(rownames(categoryOverlap),categoriesNameMatcher$Annot)]
	
	outputData <- rbind("FET pValue", FTpVal,"FDR corrected",adjustedPval,"Overlap",categoryOverlap,"CategoryHitsInDataSet(ADJ)",numCategoryHitsInDataset,"CategoryHitsInDataSet(Unadj)",numCategoryHitsInDataset.UNADJ,"OverlappedGeneLists",hitLists)
	write.csv(outputData,file = paste0(outputtabs,"/",FileBaseName,".Overlap.in.",refDataFile,"-",duplicateHandling,"-hitListStats.csv"))

	#auto-check if all FET (BH) calculations = 1, then switch to p value visualization
		if(length(dim(adjustedPval))<2) {  #*** handle single input list
	  adjustedPval<-matrix(adjustedPval,byrow=TRUE,nrow=1)
	  FTpVal<-matrix(FTpVal,byrow=TRUE,nrow=1)
	  NegLogCorr<-matrix(NegLogCorr,byrow=TRUE,nrow=1)
	  NegLogUncorr<-matrix(NegLogUncorr,byrow=TRUE,nrow=1)
	}
	if(mean(rowMeans(adjustedPval,na.rm=T),na.rm=T)==1) { this.heatmapScale<-"p.unadj"; addText="-No FDR values lower than 100%"; } else { this.heatmapScale<-heatmapScale; addText=""; }
	
	## Use the text function with the FDR filter in labeledHeatmap to add asterisks, e.g. * 
	 txtMat <- adjustedPval
	 txtMat[adjustedPval>=0.05] <- ""
	  txtMat[adjustedPval <0.05&adjustedPval >0.01] <- "*"
	  txtMat[adjustedPval <0.01&adjustedPval >0.005] <- "**"
	  txtMat[adjustedPval <0.005] <- "***"
	
	  txtMat1 <- signif(adjustedPval,2)
	  txtMat1[adjustedPval>0.25] <- ""
	
	  
	  textMatrix1 = paste( txtMat1, txtMat , sep = ' ');
	  textMatrix1= matrix(textMatrix1,ncol=ncol(adjustedPval),nrow=nrow(adjustedPval))
	
	  #for textMatrix of p.unadj
	 txtMat <- FTpVal
	 txtMat[FTpVal>=0.05] <- ""
	  txtMat[FTpVal <0.05&FTpVal >0.01] <- "*"
	  txtMat[FTpVal <0.01&FTpVal >0.005] <- "**"
	  txtMat[FTpVal <0.005] <- "***"
	
	  txtMat.p.unadj <- signif(FTpVal,2)
	  txtMat.p.unadj[FTpVal>0.25] <- ""
	
	  textMatrix.p.unadj = paste( txtMat.p.unadj, txtMat , sep = ' ');
	  textMatrix.p.unadj= matrix(textMatrix.p.unadj,ncol=ncol(FTpVal),nrow=nrow(FTpVal))
	
	
	## Plotting
	if(!barOption) {
		par(mfrow=c(verticalCompression,1))
		par( mar = c(9.5, 10, 4.5, 2) ) #bottom, left, top, right #text lines
		
		if(exists("colvec")) suppressWarnings(rm(colvec))
		
		#RColorBrewer::display.brewer.all()
		if(iter>length(paletteColors)) {
		   cat(paste0("  - paletteColors specified being recycled for additional heatmaps for inputs after #",length(paletteColors),"\n"))
		   paletteColors<-c(paletteColors,rep(paletteColors,ceiling(length(refDataFiles)/length(paletteColors))))
		}
		if(!paletteColors[iter] %in% c("YlOrRd","YlOrBr","YlGnBu","YlGn","Reds","RdPu","Purples","PuRd","PuBuGn","PuBu","OrRd","Oranges","Greys","Greens","GnBu","BuPu","BnGn","Blues",
		                           "Spectral","RdYlGn","RdYlBu","RdGy","RdBu","PuOr","PRGn","PiYG","BrBG")) {
		   cat(paste0("  - paletteColors specified as '",paletteColors[iter],"' is not in RColorBrewer::display.brewer.all() groups 1 or 3.\n    Using palette 'YlGnBu' (yellow, green, blue)...\n"))
		   paletteColors[iter]="YlGnBu"
		}
		if(paletteColors[iter] %in% c("YlOrRd","YlOrBr","YlGnBu","YlGn","Reds","RdPu","Purples","PuRd","PuBuGn","PuBu","OrRd","Oranges","Greys","Greens","GnBu","BuPu","BnGn","Blues")) {
		   paletteLength=9
		   outOfParkColor=brewer.pal(paletteLength,paletteColors[iter])[paletteLength]
		   colvec<- brewer.pal(paletteLength,paletteColors[iter])[1:6]
		} else {
		   paletteLength=11
		   # pure purple for outOfPark maximum scale color, deprecated.
		   # if(paletteColors[iter] %in% c("Spectral","RdYlGn","RdYlBu","RdGy","RdBu","PuOr","BrBG")) { outOfParkColor="#A020F0" } else { outOfParkColor="darkviolet" }
		   outOfParkColor=brewer.pal(paletteLength,paletteColors[iter])[paletteLength]
#		   if(as.boolean(revPalette[iter])) {
		      colvec<- rev(brewer.pal(paletteLength,paletteColors[iter])[1:6])  #rev so we take the left side of the palette color swatches
#		   } else {
#		      colvec<- brewer.pal(paletteLength,paletteColors[iter])[6:11]  #no rev if we want to take the right half of the palette color swatches
#		   }
		}
		   
		colvecRamped1<- vector()
		for (k in 1:(length(colvec)-1)) {
		   gradations <- if (k<4) { 6 } else { 25 }
		   temp<-colorRampPalette(c(colvec[k],colvec[k+1]))
		   colvecRamped1<-c(colvecRamped1, temp(gradations))
		}
		
		temp2<-colorRampPalette(c(colvecRamped1[length(colvecRamped1)], outOfParkColor)) ## grade to outOfParkColor at top of scale
		colvecRamped1<-c(colvecRamped1, temp2(gradations))
		
		colvecRamped1<-c("#FFFFFF",colvecRamped1)  ## grade to white at bottom of scale
		
		
		if (modulesInMemory) { categoryColorSymbols=paste0("ME",names(moduleList)) } else { if(!length(na.omit(match(orderedLabelsByRelatedness[,2],rownames(NegLogUncorr))))==nrow(orderedLabelsByRelatedness)) { categoryColorSymbols=dummyColors } else { categoryColorSymbols=names(moduleList) } }
		xSymbolsText= ifelse ( rep(modulesInMemory,length(names(moduleList))), paste0(names(moduleList)," ",orderedModules[match(names(moduleList),orderedModules[,2]),1]), names(moduleList) )
		if (this.heatmapScale=="p.unadj") {
		labeledHeatmap(Matrix = FTpVal,
		               yLabels = names(categories), #refData list elements, ordered by size if that option was on
		               xLabels = categoryColorSymbols,
		               xLabelsAngle = 90,
		               xSymbols = xSymbolsText,
		               xColorLabels=FALSE,
		               colors = rev(colvecRamped1),
		               textMatrix =  textMatrix.p.unadj,
		               setStdMargins = FALSE,
		               cex.text = 0.6,
		               cex.lab.y = 0.7,
		               verticalSeparator.x=c(rep(c(1:length(names(moduleList))),nrow(orderedLabelsByRelatedness))),
		               verticalSeparator.col = 1,
		               verticalSeparator.lty = 1,
		               verticalSeparator.lwd = 1,
		               verticalSeparator.ext = 0,
		               horizontalSeparator.y=c(rep(c(1:length(names(categories))),nrow(orderedLabelsByRelatedness))),
		               horizontalSeparator.col = 1,
		               horizontalSeparator.lty = 1,
		               horizontalSeparator.lwd = 1,
		               horizontalSeparator.ext = 0,
		               zlim = c(min(FTpVal),1),
		               main = paste0("Enrichment of ",this.heatmapTitle,"\nof ",refDataFile," Marker Lists by Gene Symbol (",duplicateHandling,")\nHeatmap: Fisher Exact p value, Uncorrected\n (p-values shown",addText,")"),
		               cex.main=0.8)
		}
		
		if (this.heatmapScale=="minusLogFDR") {
		labeledHeatmap(Matrix = NegLogCorr,
		               yLabels = names(categories), #refData list elements, ordered by size if that option was on
		               xLabels = categoryColorSymbols,
		               xLabelsAngle = 90,
		               xSymbols = xSymbolsText,
		               xColorLabels=FALSE,
		               colors = colvecRamped1,
		               textMatrix = textMatrix1, #signif(adjustedPval, 2),
		               setStdMargins = FALSE,
		               cex.text = 0.6,
		               cex.lab.y = 0.7,
		               verticalSeparator.x=c(rep(c(1:length(names(moduleList))),nrow(orderedLabelsByRelatedness))),
		               verticalSeparator.col = 1,
		               verticalSeparator.lty = 1,
		               verticalSeparator.lwd = 1,
		               verticalSeparator.ext = 0,
		               horizontalSeparator.y=c(rep(c(1:length(names(categories))),nrow(orderedLabelsByRelatedness))),
		               horizontalSeparator.col = 1,
		               horizontalSeparator.lty = 1,
		               horizontalSeparator.lwd = 1,
		               horizontalSeparator.ext = 0,
		               zlim = c(0,max(NegLogCorr,na.rm=TRUE)),
		               main = paste0("Enrichment of ",this.heatmapTitle,"\nof ",refDataFile," Marker Lists by Gene Symbol (",duplicateHandling,")\nHeatmap: -log(p), BH Corrected\n (Corrected p-values, FDR, shown)"), #*** Uncorrected\n (p-values shown)"),
		               cex.main=0.8)
		}
	} else {  #if barOption==TRUE:  PLOT BAR PLOTS FOR EACH REFERENCE LIST
		par(mfrow=c(verticalCompression,2))
		par(mar=c(15,7,4,1))
	
		moduleColors= if (modulesInMemory) { names(moduleList) } else { "bisque4" }  # if (modulesInMemory), expect colors for names(moduleList)
		xSymbolsText= ifelse ( rep(modulesInMemory,length(names(moduleList))), paste0(names(moduleList)," ",orderedModules[match(names(moduleList),orderedModules[,2]),1]), names(moduleList) )
		if (this.heatmapScale=="p.unadj") {
		
			for( i in 1:nrow(NegLogUncorr)) {
				plotting <- NegLogUncorr[i,]
				cellType <- rownames(NegLogUncorr)[i]
				barplot(plotting,main = cellType, ylab="",cex.names=1.1, width=1.5,las=2,cex.main=2, legend.text=F,col=moduleColors,names.arg=xSymbolsText)
				mtext(side=2, line=3, "-log(pValue)\n(Uncorrected)", col="black", font=1, cex=1.5)
				abline(h=1.3,col="red")
			}
		}
		
		if (this.heatmapScale=="minusLogFDR") {
			for( i in 1:nrow(NegLogCorr)) {
				plotting <- NegLogCorr[i,]
				cellType <- rownames(NegLogCorr)[i]
				barplot(plotting,main = cellType, ylab="",cex.names=1.1, width=1.5,las=2,cex.main=2, legend.text=F,col=moduleColors,names.arg=xSymbolsText)
				mtext(side=2, line=3, "-log(FDR)\n(Benjamini-Hochberg Correction)", col="black", font=1, cex=1.5)
				abline(h=1.3,col="red")
			}
		}
	
	} #ends if(!barOption)
	
	
	#+#+#+#+#+#+#+#+#+#+#+#+#+
} #end for(refDataFile ...
dev.off()
}
